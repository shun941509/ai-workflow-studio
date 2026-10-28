-- Approval is a historical decision. Publication and restoration recheck the current rights authority.
-- This private helper exposes no report, identity or storage path to ordinary clients.
create function public.has_current_publication_evidence(p_submission uuid) returns boolean language plpgsql stable security definer set search_path='' as $$
declare scan public.publication_scans; candidate public.publication_candidates; review public.publication_reviews; expires timestamptz;
begin
  select * into scan from public.publication_scans where submission_id=p_submission;
  select * into candidate from public.publication_candidates where submission_id=p_submission;
  select * into review from public.publication_reviews where submission_id=p_submission;
  if scan.id is null or candidate.submission_id is null or review.id is null
    or review.decision is distinct from 'approved'
    or not coalesce(scan.passed and scan.license_checked and scan.dependencies_checked and scan.secrets_checked,false)
    or scan.artifact_sha256 is distinct from candidate.artifact_sha256
    or review.artifact_sha256 is distinct from candidate.artifact_sha256
    or scan.evidence->>'sourceSnapshotSha256' is distinct from candidate.source_snapshot_sha256
    or scan.evidence->>'artifactBytes' is distinct from candidate.artifact_bytes::text
    or scan.evidence->>'scannerVersion' is distinct from '1.0.0'
    or scan.evidence->>'status' is distinct from 'passed'
    or scan.evidence->'rightsEvidence'->>'artifactSha256' is distinct from candidate.artifact_sha256
    or scan.evidence->'rightsEvidence'->>'sourceSnapshotSha256' is distinct from candidate.source_snapshot_sha256
    or scan.evidence->'rightsEvidence'->>'redistribution' is distinct from 'true'
    or scan.evidence->'rightsEvidence'->>'scope' is distinct from 'whole-package'
    or scan.manifest_sha256 is null
  then return false; end if;
  begin expires:=(scan.evidence->'rightsEvidence'->>'expiresAt')::timestamptz;
  exception when others then return false; end;
  return expires is not null and isfinite(expires) and expires>now()
    and exists(select 1 from public.publication_rights_authorities a
      where a.key_id=scan.evidence->'rightsEvidence'->'signature'->>'keyId'
      and a.public_key_sha256=scan.evidence->>'rightsKeySha256' and a.revoked_at is null);
end $$;
revoke all on function public.has_current_publication_evidence(uuid) from public,anon,authenticated;
grant execute on function public.has_current_publication_evidence(uuid) to service_role;

-- Retry may return the same immutable published record; changed metadata or a withdrawn release is never republished.
create or replace function public.publish_reviewed_release(p_submission uuid,p_artifact_sha text,p_title text,p_description text,p_storage_path text,p_official boolean default false) returns uuid language plpgsql security definer set search_path='' as $$
declare submission public.publication_submissions; scan public.publication_scans; review public.publication_reviews; previous public.public_releases; result_id uuid;
begin
  select * into submission from public.publication_submissions where id=p_submission for update;
  if submission.status is null or submission.status not in ('approved','published') then raise exception 'INVALID_PUBLICATION_STATE'; end if;
  if not public.has_current_publication_evidence(p_submission) then raise exception 'RELEASE_EVIDENCE_INVALID'; end if;
  select * into scan from public.publication_scans where submission_id=p_submission;
  select * into review from public.publication_reviews where submission_id=p_submission;
  if scan.artifact_sha256 is distinct from p_artifact_sha then raise exception 'RELEASE_HASH_MISMATCH'; end if;
  if p_official is null then raise exception 'INVALID_RELEASE_METADATA'; end if;
  if p_official and not exists(select 1 from public.studio_roles where user_id=review.reviewer_id and role='administrator') then raise exception 'OFFICIAL_ADMIN_REQUIRED'; end if;
  if p_storage_path is null or p_storage_path !~ '^releases/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+\.zip$' then raise exception 'INVALID_RELEASE_PATH'; end if;
  select * into previous from public.public_releases where submission_id=p_submission for update;
  if found then
    if submission.status<>'published' or previous.status<>'published'
      or previous.artifact_sha256 is distinct from p_artifact_sha or previous.manifest_sha256 is distinct from scan.manifest_sha256
      or previous.title is distinct from p_title or previous.description is distinct from p_description
      or previous.storage_path is distinct from p_storage_path or previous.is_official is distinct from p_official
    then raise exception 'RELEASE_RETRY_CONFLICT'; end if;
    return previous.id;
  end if;
  if submission.status<>'approved' then raise exception 'INVALID_PUBLICATION_STATE'; end if;
  insert into public.public_releases(submission_id,owner_id,kind,title,description,artifact_sha256,manifest_sha256,storage_path,is_official)
    values(p_submission,submission.owner_id,submission.kind,p_title,p_description,p_artifact_sha,scan.manifest_sha256,p_storage_path,p_official) returning id into result_id;
  update public.publication_submissions set status='published' where id=p_submission;
  insert into public.publication_audit(submission_id,release_id,action,detail)
    values(p_submission,result_id,'published',jsonb_build_object('artifactSha256',p_artifact_sha,'reportSha256',scan.evidence->>'reportSha256'));
  return result_id;
end $$;
revoke all on function public.publish_reviewed_release(uuid,text,text,text,text,boolean) from public,anon,authenticated;
grant execute on function public.publish_reviewed_release(uuid,text,text,text,text,boolean) to service_role;

-- Suspension remains reversible only while the exact approved artifact and its current evidence are still valid.
create or replace function public.moderate_release(p_release uuid,p_status text,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare item public.public_releases; scan public.publication_scans;
begin
  if not public.has_studio_role(array['moderator','administrator']) then raise exception 'MODERATOR_ROLE_REQUIRED' using errcode='42501'; end if;
  if p_status is null or p_status not in ('suspended','revoked','published') or p_reason is null or length(p_reason) not between 10 and 4000 then raise exception 'INVALID_MODERATION'; end if;
  select * into item from public.public_releases where id=p_release for update;
  if not found then raise exception 'RELEASE_NOT_FOUND'; end if;
  if p_status='published' then
    if item.status='revoked' then raise exception 'REVOKED_RELEASE_NEEDS_NEW_REVIEW'; end if;
    if not public.has_current_publication_evidence(item.submission_id) then raise exception 'RELEASE_EVIDENCE_INVALID'; end if;
    select * into scan from public.publication_scans where submission_id=item.submission_id;
    if item.artifact_sha256 is distinct from scan.artifact_sha256 or item.manifest_sha256 is distinct from scan.manifest_sha256 then raise exception 'RELEASE_HASH_MISMATCH'; end if;
  end if;
  update public.public_releases set status=p_status where id=p_release;
  insert into public.publication_audit(actor_id,release_id,action,detail) values(auth.uid(),p_release,'moderated',jsonb_build_object('status',p_status,'reason',p_reason));
end $$;
revoke all on function public.moderate_release(uuid,text,text) from public,anon;
grant execute on function public.moderate_release(uuid,text,text) to authenticated;
