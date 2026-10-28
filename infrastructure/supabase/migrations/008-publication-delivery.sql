-- Package-signing trust is operator-owned and separate from redistribution-rights attestations.
create table public.publication_signing_keys (
  key_id text primary key check(key_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  public_key_pem text not null check(length(public_key_pem) between 50 and 4096),
  public_key_sha256 text not null check(public_key_sha256 ~ '^[a-f0-9]{64}$'),
  not_before timestamptz not null check(isfinite(not_before)),
  expires_at timestamptz not null check(isfinite(expires_at) and expires_at>not_before),
  revoked_at timestamptz check(revoked_at is null or isfinite(revoked_at)),
  created_at timestamptz not null default now()
);
alter table public.publication_signing_keys enable row level security;
revoke all on public.publication_signing_keys from anon,authenticated;
grant select,insert,update on public.publication_signing_keys to service_role;

-- Rotation needs a new identity; changing a trusted key in place or clearing revocation is forbidden.
create function public.keep_publication_signing_identity() returns trigger language plpgsql set search_path='' as $$
begin
  if new.key_id is distinct from old.key_id or new.public_key_pem is distinct from old.public_key_pem
    or new.public_key_sha256 is distinct from old.public_key_sha256 or new.not_before is distinct from old.not_before
    or new.expires_at is distinct from old.expires_at or new.created_at is distinct from old.created_at
    or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)
  then raise exception 'SIGNING_KEY_IMMUTABLE'; end if;
  return new;
end $$;
revoke all on function public.keep_publication_signing_identity() from public,anon,authenticated;
create trigger signing_key_immutable before update on public.publication_signing_keys for each row execute function public.keep_publication_signing_identity();

create table public.publication_delivery_artifacts (
  release_id uuid primary key references public.public_releases(id),
  artifact_sha256 text not null check(artifact_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_sha256 text not null check(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_bytes bigint not null check(artifact_bytes between 1 and 33554432),
  signing_key_id text not null references public.publication_signing_keys(key_id),
  signing_key_sha256 text not null check(signing_key_sha256 ~ '^[a-f0-9]{64}$'),
  target_host text not null check(target_host in ('codex','claude-code','opencode')),
  storage_path text not null unique,
  created_at timestamptz not null default now()
);
alter table public.publication_delivery_artifacts enable row level security;
revoke all on public.publication_delivery_artifacts from anon,authenticated;
grant select on public.publication_delivery_artifacts to service_role;
-- No browser object policy is created; a public URL cannot bypass current release/rights checks.
insert into storage.buckets(id,name,public,file_size_limit) values('publication-releases','publication-releases',false,33554432)
  on conflict(id) do update set public=false,file_size_limit=33554432;

-- Registration pins metadata; every read still verifies the real stored bytes and signature before sending them.
create function public.register_publication_delivery(p_release uuid,p_artifact_sha text,p_manifest_sha text,p_bytes bigint,p_key_id text,p_key_sha text,p_host text) returns void language plpgsql security definer set search_path='' as $$
declare item public.public_releases; candidate public.publication_candidates; previous public.publication_delivery_artifacts; key public.publication_signing_keys; expected_path text;
begin
  select * into item from public.public_releases where id=p_release for update;
  if item.id is null or item.status<>'published' or not public.has_current_publication_evidence(item.submission_id) then raise exception 'DELIVERY_NOT_AVAILABLE'; end if;
  select * into candidate from public.publication_candidates where submission_id=item.submission_id;
  expected_path:='releases/'||item.submission_id::text||'/'||item.artifact_sha256||'.zip';
  if item.artifact_sha256 is distinct from p_artifact_sha or item.manifest_sha256 is distinct from p_manifest_sha
    or candidate.artifact_sha256 is distinct from p_artifact_sha or candidate.artifact_bytes is distinct from p_bytes
    or item.storage_path is distinct from expected_path or p_host is null or p_host not in ('codex','claude-code','opencode')
  then raise exception 'DELIVERY_ARTIFACT_MISMATCH'; end if;
  select * into key from public.publication_signing_keys where key_id=p_key_id;
  if key.key_id is null or key.public_key_sha256 is distinct from p_key_sha or key.revoked_at is not null
    or key.not_before>now() or key.expires_at<=now() then raise exception 'DELIVERY_SIGNING_KEY_INVALID'; end if;
  select * into previous from public.publication_delivery_artifacts where release_id=p_release;
  if found then
    if previous.artifact_sha256 is distinct from p_artifact_sha or previous.manifest_sha256 is distinct from p_manifest_sha
      or previous.artifact_bytes is distinct from p_bytes or previous.signing_key_id is distinct from p_key_id
      or previous.signing_key_sha256 is distinct from p_key_sha or previous.target_host is distinct from p_host
      or previous.storage_path is distinct from expected_path then raise exception 'DELIVERY_RETRY_CONFLICT'; end if;
    return;
  end if;
  insert into public.publication_delivery_artifacts(release_id,artifact_sha256,manifest_sha256,artifact_bytes,signing_key_id,signing_key_sha256,target_host,storage_path)
    values(p_release,p_artifact_sha,p_manifest_sha,p_bytes,p_key_id,p_key_sha,p_host,expected_path);
  insert into public.publication_audit(release_id,action,detail) values(p_release,'delivery_registered',jsonb_build_object('artifactSha256',p_artifact_sha,'signingKeyId',p_key_id));
end $$;
revoke all on function public.register_publication_delivery(uuid,text,text,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.register_publication_delivery(uuid,text,text,bigint,text,text,text) to service_role;

-- This private projection is the only delivery lookup: no caller can ask for arbitrary Storage objects or keys.
create function public.resolve_publication_delivery(p_release uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare item public.public_releases; delivery public.publication_delivery_artifacts; candidate public.publication_candidates; scan public.publication_scans; key public.publication_signing_keys;
begin
  select * into item from public.public_releases where id=p_release;
  if item.id is null or item.status<>'published' or not public.has_current_publication_evidence(item.submission_id) then raise exception 'DELIVERY_NOT_AVAILABLE'; end if;
  select * into delivery from public.publication_delivery_artifacts where release_id=p_release;
  select * into candidate from public.publication_candidates where submission_id=item.submission_id;
  select * into scan from public.publication_scans where submission_id=item.submission_id;
  if delivery.release_id is null or delivery.artifact_sha256 is distinct from item.artifact_sha256
    or delivery.manifest_sha256 is distinct from item.manifest_sha256 or delivery.manifest_sha256 is distinct from scan.manifest_sha256
    or delivery.artifact_bytes is distinct from candidate.artifact_bytes or delivery.storage_path is distinct from item.storage_path
    or delivery.storage_path is distinct from 'releases/'||item.submission_id::text||'/'||item.artifact_sha256||'.zip'
  then raise exception 'DELIVERY_NOT_AVAILABLE'; end if;
  select * into key from public.publication_signing_keys where key_id=delivery.signing_key_id;
  if key.key_id is null or key.public_key_sha256 is distinct from delivery.signing_key_sha256 or key.revoked_at is not null
    or key.not_before>now() or key.expires_at<=now() then raise exception 'DELIVERY_NOT_AVAILABLE'; end if;
  return jsonb_build_object('releaseId',item.id,'submissionId',item.submission_id,'artifactSha256',delivery.artifact_sha256,
    'manifestSha256',delivery.manifest_sha256,'artifactBytes',delivery.artifact_bytes,'targetHost',delivery.target_host,'storagePath',delivery.storage_path,
    'sourceSnapshotSha256',candidate.source_snapshot_sha256,'report',scan.evidence,
    'signingKey',jsonb_build_object('id',key.key_id,'publicKey',key.public_key_pem,'sha256',key.public_key_sha256,'notBefore',key.not_before,'expiresAt',key.expires_at));
end $$;
revoke all on function public.resolve_publication_delivery(uuid) from public,anon,authenticated;
grant execute on function public.resolve_publication_delivery(uuid) to service_role;
