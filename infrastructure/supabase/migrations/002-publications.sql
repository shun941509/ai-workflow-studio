-- Public distribution has a separate immutable lifecycle; private drafts never become public by a flag.
create table public.studio_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('reviewer','moderator','administrator')),
  primary key(user_id,role)
);
alter table public.studio_roles enable row level security;
revoke all on public.studio_roles from anon,authenticated;
grant all on public.studio_roles to service_role;

-- A security-definer helper reads only the caller's assigned roles and avoids recursive role-table RLS.
create function public.has_studio_role(p_roles text[]) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.studio_roles where user_id=auth.uid() and role=any(p_roles))
$$;
revoke all on function public.has_studio_role(text[]) from public;
grant execute on function public.has_studio_role(text[]) to authenticated,service_role;

create table public.publication_submissions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  kind text not null check (kind in ('project','resource')),
  project_revision_id uuid,
  resource_version_id uuid,
  source_snapshot jsonb not null check (jsonb_typeof(source_snapshot)='object'),
  status text not null default 'submitted' check (status in ('submitted','scanned','changes_requested','approved','rejected','published','withdrawn')),
  created_at timestamptz not null default now(),
  check ((kind='project' and project_revision_id is not null and resource_version_id is null) or (kind='resource' and resource_version_id is not null and project_revision_id is null))
);
create table public.publication_scans (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references public.publication_submissions(id),
  artifact_sha256 text not null check (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  passed boolean not null,
  license_checked boolean not null,
  dependencies_checked boolean not null,
  secrets_checked boolean not null,
  evidence jsonb not null check (jsonb_typeof(evidence)='object'),
  created_at timestamptz not null default now()
);
create table public.publication_reviews (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references public.publication_submissions(id),
  reviewer_id uuid not null references auth.users(id),
  artifact_sha256 text not null check (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  decision text not null check (decision in ('approved','rejected')),
  reason text not null check (length(reason) between 1 and 4000),
  created_at timestamptz not null default now()
);
create table public.public_releases (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references public.publication_submissions(id),
  owner_id uuid not null references auth.users(id),
  kind text not null check (kind in ('project','resource')),
  title text not null check (length(title) between 1 and 200),
  description text not null check (length(description)<=4000),
  artifact_sha256 text not null check (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  storage_path text not null unique,
  status text not null default 'published' check (status in ('published','suspended','revoked')),
  is_official boolean not null default false,
  created_at timestamptz not null default now()
);
create index public_release_search on public.public_releases(kind,created_at desc) where status='published';
create table public.release_reports (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.public_releases(id),
  reporter_id uuid not null references auth.users(id),
  reason text not null check (length(reason) between 10 and 4000),
  status text not null default 'open' check (status in ('open','investigating','resolved','dismissed')),
  created_at timestamptz not null default now()
);
create table public.publication_audit (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  submission_id uuid references public.publication_submissions(id),
  release_id uuid references public.public_releases(id),
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.publication_submissions enable row level security;
alter table public.publication_scans enable row level security;
alter table public.publication_reviews enable row level security;
alter table public.public_releases enable row level security;
alter table public.release_reports enable row level security;
alter table public.publication_audit enable row level security;
revoke all on public.publication_submissions,public.publication_scans,public.publication_reviews,public.public_releases,public.release_reports,public.publication_audit from anon,authenticated;
grant select on public.publication_submissions,public.publication_scans,public.publication_reviews,public.public_releases,public.release_reports,public.publication_audit to authenticated;
grant select on public.public_releases to anon;
grant all on public.publication_submissions,public.publication_scans,public.publication_reviews,public.public_releases,public.release_reports,public.publication_audit to service_role;
grant usage,select on sequence public.publication_audit_id_seq to service_role;
create policy submission_visible on public.publication_submissions for select to authenticated using (owner_id=auth.uid() or public.has_studio_role(array['reviewer','administrator']));
create policy scan_visible on public.publication_scans for select to authenticated using (exists(select 1 from public.publication_submissions s where s.id=submission_id));
create policy review_visible on public.publication_reviews for select to authenticated using (exists(select 1 from public.publication_submissions s where s.id=submission_id));
create policy release_public on public.public_releases for select to anon,authenticated using (status='published');
create policy release_staff on public.public_releases for select to authenticated using (owner_id=auth.uid() or public.has_studio_role(array['moderator','administrator']));
create policy report_visible on public.release_reports for select to authenticated using (reporter_id=auth.uid() or public.has_studio_role(array['moderator','administrator']));
create policy audit_staff on public.publication_audit for select to authenticated using (public.has_studio_role(array['reviewer','moderator','administrator']));

-- Only the immutable source version owned by this caller may enter the submission queue.
create function public.submit_publication(p_kind text,p_version_id uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare result_id uuid; owner uuid; source jsonb;
begin
  owner:=auth.uid();
  if owner is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  if p_kind='project' then
    select to_jsonb(v) into source from public.project_revisions v join public.projects p on p.id=v.project_id where v.id=p_version_id and p.owner_id=owner;
  elsif p_kind='resource' then
    select jsonb_build_object('version',to_jsonb(v),'name',r.name,'kind',r.kind) into source from public.resource_versions v join public.resources r on r.id=v.resource_id where v.id=p_version_id and r.owner_id=owner;
  else raise exception 'INVALID_KIND'; end if;
  if source is null then raise exception 'SOURCE_NOT_FOUND' using errcode='42501'; end if;
  -- Capture the submitted revision now; later deleting a private original cannot rewrite a reviewed release.
  insert into public.publication_submissions(owner_id,kind,project_revision_id,resource_version_id,source_snapshot)
    values(owner,p_kind,case when p_kind='project' then p_version_id end,case when p_kind='resource' then p_version_id end,source) returning id into result_id;
  insert into public.publication_audit(actor_id,submission_id,action) values(owner,result_id,'submitted');
  return result_id;
end $$;

-- Scanner attestation is a privileged backend operation. The scanner must inspect exact ZIP bytes and dependencies.
create function public.record_publication_scan(p_submission uuid,p_artifact_sha text,p_manifest_sha text,p_passed boolean,p_license boolean,p_dependencies boolean,p_secrets boolean,p_evidence jsonb) returns void language plpgsql security definer set search_path='' as $$
declare current_status text;
begin
  select status into current_status from public.publication_submissions where id=p_submission for update;
  if current_status is distinct from 'submitted' then raise exception 'INVALID_PUBLICATION_STATE'; end if;
  insert into public.publication_scans(submission_id,artifact_sha256,manifest_sha256,passed,license_checked,dependencies_checked,secrets_checked,evidence)
    values(p_submission,p_artifact_sha,p_manifest_sha,p_passed,p_license,p_dependencies,p_secrets,p_evidence);
  update public.publication_submissions set status=case when p_passed and p_license and p_dependencies and p_secrets then 'scanned' else 'changes_requested' end where id=p_submission;
  insert into public.publication_audit(submission_id,action,detail) values(p_submission,'scan_recorded',jsonb_build_object('artifactSha256',p_artifact_sha,'passed',p_passed));
end $$;

-- A review is bound to the exact scanned artifact; changing files requires another submission and review.
create function public.review_publication(p_submission uuid,p_artifact_sha text,p_decision text,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare scan public.publication_scans; current_status text;
begin
  if not public.has_studio_role(array['reviewer','administrator']) then raise exception 'REVIEW_ROLE_REQUIRED' using errcode='42501'; end if;
  select status into current_status from public.publication_submissions where id=p_submission for update;
  if current_status is distinct from 'scanned' then raise exception 'INVALID_PUBLICATION_STATE'; end if;
  select * into scan from public.publication_scans where submission_id=p_submission;
  if scan.artifact_sha256 is distinct from p_artifact_sha or not(scan.passed and scan.license_checked and scan.dependencies_checked and scan.secrets_checked) then raise exception 'REVIEW_HASH_MISMATCH'; end if;
  if p_decision not in ('approved','rejected') then raise exception 'INVALID_REVIEW_DECISION'; end if;
  insert into public.publication_reviews(submission_id,reviewer_id,artifact_sha256,decision,reason) values(p_submission,auth.uid(),p_artifact_sha,p_decision,p_reason);
  update public.publication_submissions set status=p_decision where id=p_submission;
  insert into public.publication_audit(actor_id,submission_id,action,detail) values(auth.uid(),p_submission,'reviewed',jsonb_build_object('decision',p_decision,'artifactSha256',p_artifact_sha));
end $$;

-- Publishing commits only already-reviewed bytes. Signing and upload belong to the backend job before this commit.
create function public.publish_reviewed_release(p_submission uuid,p_artifact_sha text,p_title text,p_description text,p_storage_path text,p_official boolean default false) returns uuid language plpgsql security definer set search_path='' as $$
declare submission public.publication_submissions; scan public.publication_scans; review public.publication_reviews; result_id uuid;
begin
  select * into submission from public.publication_submissions where id=p_submission for update;
  if submission.status is distinct from 'approved' then raise exception 'INVALID_PUBLICATION_STATE'; end if;
  select * into scan from public.publication_scans where submission_id=p_submission;
  select * into review from public.publication_reviews where submission_id=p_submission;
  if review.decision is distinct from 'approved' or review.artifact_sha256 is distinct from p_artifact_sha or scan.artifact_sha256 is distinct from p_artifact_sha then raise exception 'RELEASE_HASH_MISMATCH'; end if;
  if p_official and not exists(select 1 from public.studio_roles where user_id=review.reviewer_id and role='administrator') then raise exception 'OFFICIAL_ADMIN_REQUIRED'; end if;
  if p_storage_path !~ '^releases/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+\.zip$' then raise exception 'INVALID_RELEASE_PATH'; end if;
  insert into public.public_releases(submission_id,owner_id,kind,title,description,artifact_sha256,manifest_sha256,storage_path,is_official)
    values(p_submission,submission.owner_id,submission.kind,p_title,p_description,p_artifact_sha,scan.manifest_sha256,p_storage_path,p_official) returning id into result_id;
  update public.publication_submissions set status='published' where id=p_submission;
  insert into public.publication_audit(submission_id,release_id,action,detail) values(p_submission,result_id,'published',jsonb_build_object('artifactSha256',p_artifact_sha));
  return result_id;
end $$;

-- Reporting does not automatically hide content; moderation records an explicit, auditable decision.
create function public.report_release(p_release uuid,p_reason text) returns uuid language plpgsql security definer set search_path='' as $$
declare result_id uuid;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  if not exists(select 1 from public.public_releases where id=p_release and status='published') then raise exception 'RELEASE_NOT_FOUND'; end if;
  insert into public.release_reports(release_id,reporter_id,reason) values(p_release,auth.uid(),p_reason) returning id into result_id;
  return result_id;
end $$;
create function public.moderate_release(p_release uuid,p_status text,p_reason text) returns void language plpgsql security definer set search_path='' as $$
begin
  if not public.has_studio_role(array['moderator','administrator']) then raise exception 'MODERATOR_ROLE_REQUIRED' using errcode='42501'; end if;
  if p_status not in ('suspended','revoked','published') or length(p_reason) not between 10 and 4000 then raise exception 'INVALID_MODERATION'; end if;
  perform 1 from public.public_releases where id=p_release for update;
  if not found then raise exception 'RELEASE_NOT_FOUND'; end if;
  if p_status='published' and exists(select 1 from public.public_releases where id=p_release and status='revoked') then raise exception 'REVOKED_RELEASE_NEEDS_NEW_REVIEW'; end if;
  update public.public_releases set status=p_status where id=p_release;
  insert into public.publication_audit(actor_id,release_id,action,detail) values(auth.uid(),p_release,'moderated',jsonb_build_object('status',p_status,'reason',p_reason));
end $$;

revoke all on function public.submit_publication(text,uuid),public.review_publication(uuid,text,text,text),public.report_release(uuid,text),public.moderate_release(uuid,text,text) from public;
grant execute on function public.submit_publication(text,uuid),public.review_publication(uuid,text,text,text),public.report_release(uuid,text),public.moderate_release(uuid,text,text) to authenticated;
revoke all on function public.record_publication_scan(uuid,text,text,boolean,boolean,boolean,boolean,jsonb),public.publish_reviewed_release(uuid,text,text,text,text,boolean) from public;
grant execute on function public.record_publication_scan(uuid,text,text,boolean,boolean,boolean,boolean,jsonb),public.publish_reviewed_release(uuid,text,text,text,text,boolean) to service_role;
