-- Reviewers need current revocation/expiry metadata without gaining access to verifier keys or worker Storage paths.
create function public.publication_review_readiness(p_submission uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare submission public.publication_submissions; scan public.publication_scans; authority public.publication_rights_authorities;
  expires timestamptz; rights_state text:='unverified'; reasons jsonb:='[]'::jsonb; consistent boolean:=false; ready boolean:=false;
begin
  if not public.has_studio_role(array['reviewer','administrator']) then raise exception 'REVIEW_ROLE_REQUIRED' using errcode='42501'; end if;
  select * into submission from public.publication_submissions where id=p_submission;
  if not found then raise exception 'REVIEW_NOT_FOUND'; end if;
  select * into scan from public.publication_scans where submission_id=p_submission;
  if scan.id is not null then
    begin expires:=(scan.evidence->'rightsEvidence'->>'expiresAt')::timestamptz; exception when others then expires:=null; end;
    select * into authority from public.publication_rights_authorities where key_id=scan.evidence->'rightsEvidence'->'signature'->>'keyId';
    consistent:=scan.evidence->>'scannerVersion'='1.0.0' and scan.evidence->>'artifactSha256'=scan.artifact_sha256
      and scan.evidence->>'manifestSha256'=scan.manifest_sha256 and scan.evidence->>'status'='passed'
      and scan.passed and scan.license_checked and scan.dependencies_checked and scan.secrets_checked;
    if scan.evidence->'rightsEvidence'->'signature'->>'keyId' is null then rights_state:='unverified';
    elsif authority.key_id is null then rights_state:='missing';
    elsif authority.revoked_at is not null then rights_state:='revoked';
    elsif authority.public_key_sha256 is distinct from scan.evidence->>'rightsKeySha256' then rights_state:='changed';
    elsif expires is null or not isfinite(expires) or expires<=now() then rights_state:='expired';
    else rights_state:='active'; end if;
  end if;
  if submission.status<>'scanned' then reasons:=reasons||jsonb_build_array('NOT_AWAITING_REVIEW'); end if;
  if not coalesce(consistent,false) then reasons:=reasons||jsonb_build_array('SCAN_INCOMPLETE_OR_INCONSISTENT'); end if;
  if rights_state<>'active' then reasons:=reasons||jsonb_build_array('RIGHTS_'||upper(rights_state)); end if;
  ready:=submission.status='scanned' and coalesce(consistent,false) and rights_state='active';
  return jsonb_build_object('status',submission.status,'artifactSha256',scan.artifact_sha256,'reportSha256',scan.evidence->>'reportSha256',
    'canApprove',ready,'canReject',submission.status='scanned' and coalesce(scan.passed and scan.license_checked and scan.dependencies_checked and scan.secrets_checked,false),
    'rights',jsonb_build_object('state',rights_state,'expiresAt',expires,'checkedAt',now()),'blockedReasons',reasons,'published',submission.status='published');
end $$;
revoke all on function public.publication_review_readiness(uuid) from public,anon;
grant execute on function public.publication_review_readiness(uuid) to authenticated;
