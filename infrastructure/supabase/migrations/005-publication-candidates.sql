-- A scan worker reads only a previously pinned private object. Browser/reviewer clients cannot register candidates.
create table public.publication_candidates (
  submission_id uuid primary key references public.publication_submissions(id),
  artifact_sha256 text not null check(artifact_sha256 ~ '^[a-f0-9]{64}$'),
  source_snapshot_sha256 text not null check(source_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_bytes bigint not null check(artifact_bytes between 1 and 33554432),
  storage_path text not null unique,
  created_at timestamptz not null default now()
);
alter table public.publication_candidates enable row level security;
revoke all on public.publication_candidates from anon,authenticated;
grant select on public.publication_candidates to service_role;
insert into storage.buckets(id,name,public,file_size_limit) values('publication-candidates','publication-candidates',false,33554432) on conflict(id) do nothing;

-- Operators provision external rights-verifier identities separately. Workers never auto-trust a packaged key.
create table public.publication_rights_authorities (
  key_id text primary key check(key_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  public_key_sha256 text not null check(public_key_sha256 ~ '^[a-f0-9]{64}$'),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.publication_rights_authorities enable row level security;
revoke all on public.publication_rights_authorities from anon,authenticated;
grant select,insert,update on public.publication_rights_authorities to service_role;

create function public.register_publication_candidate(p_submission uuid,p_artifact_sha text,p_source_sha text,p_bytes bigint) returns void language plpgsql security definer set search_path='' as $$
declare previous public.publication_candidates; current_status text;
begin
  select status into current_status from public.publication_submissions where id=p_submission for update;
  if current_status is distinct from 'submitted' then raise exception 'INVALID_PUBLICATION_STATE'; end if;
  select * into previous from public.publication_candidates where submission_id=p_submission;
  if found then
    if previous.artifact_sha256 is distinct from p_artifact_sha or previous.source_snapshot_sha256 is distinct from p_source_sha or previous.artifact_bytes is distinct from p_bytes then raise exception 'CANDIDATE_CONFLICT'; end if;
    return;
  end if;
  insert into public.publication_candidates(submission_id,artifact_sha256,source_snapshot_sha256,artifact_bytes,storage_path)
    values(p_submission,p_artifact_sha,p_source_sha,p_bytes,'candidates/'||p_submission::text||'/'||p_artifact_sha||'.zip');
  insert into public.publication_audit(submission_id,action,detail) values(p_submission,'candidate_pinned',jsonb_build_object('artifactSha256',p_artifact_sha,'sourceSnapshotSha256',p_source_sha));
end $$;
revoke all on function public.register_publication_candidate(uuid,text,text,bigint) from public;
grant execute on function public.register_publication_candidate(uuid,text,text,bigint) to service_role;

-- Invalid archives still produce a real failed scan with no invented manifest digest.
alter table public.publication_scans alter column manifest_sha256 drop not null;
create or replace function public.record_publication_scan(p_submission uuid,p_artifact_sha text,p_manifest_sha text,p_passed boolean,p_license boolean,p_dependencies boolean,p_secrets boolean,p_evidence jsonb) returns void language plpgsql security definer set search_path='' as $$
declare current_status text; candidate public.publication_candidates; checks jsonb; all_passed boolean;
begin
  select status into current_status from public.publication_submissions where id=p_submission for update;
  if current_status is distinct from 'submitted' then raise exception 'INVALID_PUBLICATION_STATE'; end if;
  select * into candidate from public.publication_candidates where submission_id=p_submission;
  checks:=p_evidence->'checks';
  if candidate.submission_id is null or candidate.artifact_sha256 is distinct from p_artifact_sha
    or jsonb_typeof(p_evidence) is distinct from 'object' or p_evidence->>'schemaVersion' is distinct from '1.0.0'
    or p_evidence->>'scannerVersion' is distinct from '1.0.0' or p_evidence->>'artifactSha256' is distinct from p_artifact_sha
    or p_evidence->>'sourceSnapshotSha256' is distinct from candidate.source_snapshot_sha256
    or (p_evidence->>'artifactBytes') is distinct from candidate.artifact_bytes::text
    or (p_evidence->>'manifestSha256') is distinct from p_manifest_sha
    or p_evidence->'releaseAuthorized' is distinct from 'false'::jsonb
    or coalesce(p_evidence->>'reportSha256','') !~ '^[a-f0-9]{64}$'
    or coalesce(p_evidence->'policy'->>'sha256','') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(checks) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(checks))<>8
    or not(checks ?& array['archive','source','files','secrets','capabilities','dependencies','rights','staticRisks'])
    or exists(select 1 from jsonb_each_text(checks) c where c.value is null or c.value not in ('passed','failed','unverified'))
  then raise exception 'SCAN_EVIDENCE_MISMATCH'; end if;
  all_passed:=not exists(select 1 from jsonb_each_text(checks) c where coalesce(c.value,'')<>'passed');
  if p_passed is distinct from all_passed or p_license is distinct from (checks->>'rights'='passed')
    or p_dependencies is distinct from (checks->>'dependencies'='passed') or p_secrets is distinct from (checks->>'secrets'='passed')
    or (p_passed and (p_manifest_sha is null or p_evidence->>'status' is distinct from 'passed'))
    or (not p_passed and coalesce(p_evidence->>'status','') not in ('blocked','needs_evidence'))
    or (p_passed and (jsonb_typeof(p_evidence->'rightsEvidence') is distinct from 'object' or p_evidence->'rightsEvidence'->>'artifactSha256' is distinct from p_artifact_sha or p_evidence->'rightsEvidence'->>'sourceSnapshotSha256' is distinct from candidate.source_snapshot_sha256))
  then raise exception 'SCAN_RESULT_MISMATCH'; end if;
  if p_passed and not exists(select 1 from public.publication_rights_authorities a where a.key_id=p_evidence->'rightsEvidence'->'signature'->>'keyId' and a.public_key_sha256=p_evidence->>'rightsKeySha256' and a.revoked_at is null) then raise exception 'RIGHTS_AUTHORITY_REQUIRED'; end if;
  insert into public.publication_scans(submission_id,artifact_sha256,manifest_sha256,passed,license_checked,dependencies_checked,secrets_checked,evidence)
    values(p_submission,p_artifact_sha,p_manifest_sha,p_passed,p_license,p_dependencies,p_secrets,p_evidence);
  update public.publication_submissions set status=case when p_passed then 'scanned' else 'changes_requested' end where id=p_submission;
  insert into public.publication_audit(submission_id,action,detail) values(p_submission,'scan_recorded',jsonb_build_object('artifactSha256',p_artifact_sha,'reportSha256',p_evidence->>'reportSha256','policySha256',p_evidence->'policy'->>'sha256','passed',p_passed));
end $$;
revoke all on function public.record_publication_scan(uuid,text,text,boolean,boolean,boolean,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.record_publication_scan(uuid,text,text,boolean,boolean,boolean,boolean,jsonb) to service_role;

-- A legacy or expired attestation cannot open approval. Rejection is still a human decision on the same scanned hash.
create or replace function public.review_publication(p_submission uuid,p_artifact_sha text,p_decision text,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare scan public.publication_scans; current_status text; expires timestamptz;
begin
  if not public.has_studio_role(array['reviewer','administrator']) then raise exception 'REVIEW_ROLE_REQUIRED' using errcode='42501'; end if;
  select status into current_status from public.publication_submissions where id=p_submission for update;
  if current_status is distinct from 'scanned' then raise exception 'INVALID_PUBLICATION_STATE'; end if;
  select * into scan from public.publication_scans where submission_id=p_submission;
  if scan.artifact_sha256 is distinct from p_artifact_sha or not(scan.passed and scan.license_checked and scan.dependencies_checked and scan.secrets_checked) then raise exception 'REVIEW_HASH_MISMATCH'; end if;
  if p_decision not in ('approved','rejected') then raise exception 'INVALID_REVIEW_DECISION'; end if;
  if p_decision='approved' then
    begin expires:=(scan.evidence->'rightsEvidence'->>'expiresAt')::timestamptz;
    exception when others then raise exception 'REVIEW_EVIDENCE_EXPIRED'; end;
    if scan.evidence->>'scannerVersion' is distinct from '1.0.0' or expires is null or not isfinite(expires) or expires<=now()
      or not exists(select 1 from public.publication_rights_authorities a where a.key_id=scan.evidence->'rightsEvidence'->'signature'->>'keyId' and a.public_key_sha256=scan.evidence->>'rightsKeySha256' and a.revoked_at is null)
    then raise exception 'REVIEW_EVIDENCE_EXPIRED'; end if;
  end if;
  insert into public.publication_reviews(submission_id,reviewer_id,artifact_sha256,decision,reason) values(p_submission,auth.uid(),p_artifact_sha,p_decision,p_reason);
  update public.publication_submissions set status=p_decision where id=p_submission;
  insert into public.publication_audit(actor_id,submission_id,action,detail) values(auth.uid(),p_submission,'reviewed',jsonb_build_object('decision',p_decision,'artifactSha256',p_artifact_sha,'reportSha256',scan.evidence->>'reportSha256'));
end $$;
revoke all on function public.review_publication(uuid,text,text,text) from public;
grant execute on function public.review_publication(uuid,text,text,text) to authenticated;
