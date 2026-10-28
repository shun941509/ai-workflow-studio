-- Private authoring copies need reviewed copy/edit permission independently of package signatures and redistribution.
create table public.publication_copy_authorities (
  key_id text primary key check(key_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  public_key_pem text not null check(length(public_key_pem) between 50 and 4096),
  public_key_sha256 text not null check(public_key_sha256 ~ '^[a-f0-9]{64}$'),
  not_before timestamptz not null check(isfinite(not_before) and date_trunc('milliseconds',not_before)=not_before),
  expires_at timestamptz not null check(isfinite(expires_at) and expires_at>not_before and date_trunc('milliseconds',expires_at)=expires_at),
  revoked_at timestamptz check(revoked_at is null or isfinite(revoked_at)),
  created_at timestamptz not null default now()
);
alter table public.publication_copy_authorities enable row level security;
revoke all on public.publication_copy_authorities from anon,authenticated;
grant select,insert,update on public.publication_copy_authorities to service_role;

-- Purpose-specific keys rotate under new IDs; an old revocation cannot be cleared to revive stale grants.
create function public.keep_copy_authority_identity() returns trigger language plpgsql set search_path='' as $$
begin
  if new.key_id is distinct from old.key_id or new.public_key_pem is distinct from old.public_key_pem
    or new.public_key_sha256 is distinct from old.public_key_sha256 or new.not_before is distinct from old.not_before
    or new.expires_at is distinct from old.expires_at or new.created_at is distinct from old.created_at
    or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)
  then raise exception 'COPY_AUTHORITY_IMMUTABLE'; end if;
  return new;
end $$;
revoke all on function public.keep_copy_authority_identity() from public,anon,authenticated;
create trigger copy_authority_immutable before update on public.publication_copy_authorities for each row execute function public.keep_copy_authority_identity();

create table public.publication_copy_rights (
  evidence_sha256 text primary key check(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  release_id uuid not null references public.public_releases(id),
  artifact_sha256 text not null check(artifact_sha256 ~ '^[a-f0-9]{64}$'),
  source_snapshot_sha256 text not null check(source_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  authority_id text not null references public.publication_copy_authorities(key_id),
  authority_sha256 text not null check(authority_sha256 ~ '^[a-f0-9]{64}$'),
  reviewed_at timestamptz not null check(isfinite(reviewed_at)),
  expires_at timestamptz not null check(isfinite(expires_at) and expires_at>reviewed_at),
  evidence jsonb not null check(jsonb_typeof(evidence)='object' and octet_length(evidence::text)<=16384),
  revoked_at timestamptz check(revoked_at is null or isfinite(revoked_at)),
  created_at timestamptz not null default now()
);
create index publication_copy_rights_release on public.publication_copy_rights(release_id,reviewed_at desc,evidence_sha256);
alter table public.publication_copy_rights enable row level security;
revoke all on public.publication_copy_rights from anon,authenticated;
grant select on public.publication_copy_rights to service_role;
grant update(revoked_at) on public.publication_copy_rights to service_role;

-- Evidence is immutable even for routine service clients; only monotonic revocation is an allowed update.
create function public.keep_copy_rights_identity() returns trigger language plpgsql set search_path='' as $$
begin
  if (to_jsonb(new)-'revoked_at') is distinct from (to_jsonb(old)-'revoked_at')
    or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)
  then raise exception 'COPY_RIGHTS_IMMUTABLE'; end if;
  return new;
end $$;
revoke all on function public.keep_copy_rights_identity() from public,anon,authenticated;
create trigger copy_rights_immutable before update on public.publication_copy_rights for each row execute function public.keep_copy_rights_identity();

-- Trusted worker calls this only after verifying Ed25519 and the canonical evidence hash outside SQL.
-- The database additionally binds the attestation to the current release, source and independently registered authority.
create function public.register_publication_copy_rights(p_release uuid,p_evidence jsonb,p_evidence_sha text) returns void language plpgsql security definer set search_path='' as $$
declare delivery jsonb; authority public.publication_copy_authorities; previous public.publication_copy_rights; reviewed timestamptz; expires timestamptz; checked_at timestamptz;
begin
  -- Serialize registrations for the same release so an identical concurrent retry observes the first committed row.
  perform id from public.public_releases where id=p_release for update;
  delivery:=public.resolve_publication_delivery(p_release);
  if p_evidence_sha is null or p_evidence_sha !~ '^[a-f0-9]{64}$' or p_evidence is null or jsonb_typeof(p_evidence)<>'object' or octet_length(p_evidence::text)>16384 then raise exception 'COPY_RIGHTS_INVALID'; end if;
  if jsonb_typeof(p_evidence->'signature') is distinct from 'object' then raise exception 'COPY_RIGHTS_INVALID'; end if;
  if (select array_agg(k order by k) from jsonb_object_keys(p_evidence) k) is distinct from array['artifactSha256','evidenceSha256','expiresAt','modification','privateCopy','reviewedAt','reviewerId','schemaVersion','scope','signature','sourceSnapshotSha256']::text[]
    or p_evidence->>'schemaVersion' is distinct from '1.0.0' or p_evidence->>'scope' is distinct from 'whole-package'
    or p_evidence->'privateCopy' is distinct from 'true'::jsonb or p_evidence->'modification' is distinct from 'true'::jsonb
    or p_evidence->>'artifactSha256' is distinct from delivery->>'artifactSha256'
    or p_evidence->>'sourceSnapshotSha256' is distinct from delivery->>'sourceSnapshotSha256'
    or coalesce(p_evidence->>'evidenceSha256','') !~ '^[a-f0-9]{64}$'
    or coalesce(p_evidence->>'reviewerId','') !~ '^[A-Za-z0-9_-]{1,100}$'
    or jsonb_typeof(p_evidence->'signature') is distinct from 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(p_evidence->'signature') k) is distinct from array['keyId','value']::text[]
    or coalesce(p_evidence#>>'{signature,keyId}','') !~ '^[A-Za-z0-9_-]{1,80}$'
    or coalesce(p_evidence#>>'{signature,value}','') !~ '^[A-Za-z0-9_-]{86}$'
    or coalesce(p_evidence->>'reviewedAt','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$'
    or coalesce(p_evidence->>'expiresAt','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$'
  then raise exception 'COPY_RIGHTS_INVALID'; end if;
  reviewed:=(p_evidence->>'reviewedAt')::timestamptz; expires:=(p_evidence->>'expiresAt')::timestamptz;
  select * into authority from public.publication_copy_authorities where key_id=p_evidence#>>'{signature,keyId}' for share;
  -- now() is fixed at transaction start. A grant that expired while acquiring locks must still be rejected.
  checked_at:=clock_timestamp(); delivery:=public.resolve_publication_delivery(p_release);
  if (delivery#>>'{signingKey,notBefore}')::timestamptz>checked_at or (delivery#>>'{signingKey,expiresAt}')::timestamptz<=checked_at
    or (delivery#>>'{report,rightsEvidence,expiresAt}')::timestamptz<=checked_at then raise exception 'DELIVERY_NOT_AVAILABLE'; end if;
  if not isfinite(reviewed) or not isfinite(expires) or reviewed>checked_at or expires<=checked_at or expires<=reviewed
    or authority.key_id is null or authority.revoked_at is not null or authority.not_before>reviewed
    or authority.not_before>checked_at or authority.expires_at<=checked_at or expires>authority.expires_at
  then raise exception 'COPY_RIGHTS_UNAVAILABLE'; end if;
  select * into previous from public.publication_copy_rights where evidence_sha256=p_evidence_sha;
  if found then
    if previous.release_id is distinct from p_release or previous.evidence is distinct from p_evidence
      or previous.authority_sha256 is distinct from authority.public_key_sha256 or previous.revoked_at is not null
    then raise exception 'COPY_RIGHTS_RETRY_CONFLICT'; end if;
    return;
  end if;
  insert into public.publication_copy_rights(evidence_sha256,release_id,artifact_sha256,source_snapshot_sha256,authority_id,authority_sha256,reviewed_at,expires_at,evidence)
    values(p_evidence_sha,p_release,p_evidence->>'artifactSha256',p_evidence->>'sourceSnapshotSha256',authority.key_id,authority.public_key_sha256,reviewed,expires,p_evidence);
  insert into public.publication_audit(release_id,action,detail) values(p_release,'copy_rights_registered',jsonb_build_object('evidenceSha256',p_evidence_sha,'authorityId',authority.key_id));
end $$;
revoke all on function public.register_publication_copy_rights(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.register_publication_copy_rights(uuid,jsonb,text) to service_role;

-- Every copy preparation/commit must reread current distribution and copy rights; no browser can retrieve this private projection.
create function public.resolve_publication_copy(p_release uuid) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare delivery jsonb; permission public.publication_copy_rights; authority public.publication_copy_authorities; checked_at timestamptz;
begin
  delivery:=public.resolve_publication_delivery(p_release);
  checked_at:=clock_timestamp();
  if (delivery#>>'{signingKey,notBefore}')::timestamptz>checked_at or (delivery#>>'{signingKey,expiresAt}')::timestamptz<=checked_at
    or (delivery#>>'{report,rightsEvidence,expiresAt}')::timestamptz<=checked_at then raise exception 'DELIVERY_NOT_AVAILABLE'; end if;
  select grant_row.* into permission from public.publication_copy_rights grant_row
    join public.publication_copy_authorities key on key.key_id=grant_row.authority_id and key.public_key_sha256=grant_row.authority_sha256
    where grant_row.release_id=p_release and grant_row.artifact_sha256=delivery->>'artifactSha256'
      and grant_row.source_snapshot_sha256=delivery->>'sourceSnapshotSha256' and grant_row.revoked_at is null
      and grant_row.reviewed_at<=checked_at and grant_row.expires_at>checked_at
      and key.revoked_at is null and key.not_before<=grant_row.reviewed_at and key.expires_at>=grant_row.expires_at and key.expires_at>checked_at
    order by grant_row.reviewed_at desc,grant_row.evidence_sha256 limit 1;
  if permission.evidence_sha256 is null then raise exception 'COPY_RIGHTS_UNAVAILABLE'; end if;
  select * into authority from public.publication_copy_authorities where key_id=permission.authority_id;
  return jsonb_build_object('delivery',delivery,'copyRights',jsonb_build_object('evidence',permission.evidence,'evidenceSha256',permission.evidence_sha256,
    'authority',jsonb_build_object('purpose','private-authoring-copy','publicKey',authority.public_key_pem,'publicKeySha256',authority.public_key_sha256,
      'notBefore',to_char(authority.not_before at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'expiresAt',to_char(authority.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'revoked',false)));
end $$;
revoke all on function public.resolve_publication_copy(uuid) from public,anon,authenticated;
grant execute on function public.resolve_publication_copy(uuid) to service_role;
