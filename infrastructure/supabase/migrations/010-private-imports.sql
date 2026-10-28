-- Account copies preserve signed source bytes in private Storage. SQL validates ownership and
-- relational pins; the trusted server verifies ZIP bytes, signatures and canonical JSON hashes.
create table public.private_imports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete set null,
  request_id uuid not null,
  release_id uuid not null references public.public_releases(id),
  state text not null default 'staging' check(state in ('staging','committed','failed')),
  resolution jsonb not null,
  storage_path text not null unique,
  artifact_sha256 text not null check(artifact_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_bytes bigint not null check(artifact_bytes between 1 and 33554432),
  preparation jsonb,
  preparation_sha256 text check(preparation_sha256 ~ '^[a-f0-9]{64}$'),
  stored_at timestamptz,
  receipt jsonb,
  failure_code text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp()+interval '24 hours',
  storage_deleted_at timestamptz,
  unique(owner_id,request_id)
);
create table public.resource_archive_versions (
  version_id uuid primary key references public.resource_versions(id) on delete cascade,
  import_id uuid not null references public.private_imports(id),
  source_alias text not null,
  reference jsonb not null,
  descriptor jsonb not null,
  unique(import_id,source_alias)
);
create table public.private_resource_bindings (
  project_id uuid not null references public.projects(id) on delete cascade,
  alias text not null check(alias ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  version_id uuid not null references public.resource_versions(id),
  reference jsonb not null,
  primary key(project_id,alias)
);
create table public.private_revision_resource_bindings (
  revision_id uuid not null references public.project_revisions(id) on delete cascade,
  alias text not null,
  version_id uuid not null references public.resource_versions(id),
  reference jsonb not null,
  primary key(revision_id,alias)
);
create table public.project_origins (
  project_id uuid primary key references public.projects(id) on delete cascade,
  import_id uuid not null references public.private_imports(id),
  source jsonb not null,
  copied_at timestamptz not null default clock_timestamp()
);
create table public.resource_origins (
  version_id uuid primary key references public.resource_versions(id) on delete cascade,
  import_id uuid not null references public.private_imports(id),
  source jsonb not null,
  copied_at timestamptz not null default clock_timestamp()
);
-- The outbox has no owner FK: account deletion must not lose the exact object to clean up.
create table public.private_import_cleanup (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null unique references public.private_imports(id),
  storage_path text not null,
  expected_sha256 text not null,
  not_before timestamptz not null,
  lease_id uuid,
  lease_until timestamptz,
  attempts integer not null default 0,
  finished_at timestamptz,
  last_outcome text
);
alter table public.resources drop constraint resources_name_check;
alter table public.resources add constraint resources_name_check check(length(name) between 1 and 200);
alter table public.private_imports enable row level security;
alter table public.resource_archive_versions enable row level security;
alter table public.private_resource_bindings enable row level security;
alter table public.private_revision_resource_bindings enable row level security;
alter table public.project_origins enable row level security;
alter table public.resource_origins enable row level security;
alter table public.private_import_cleanup enable row level security;
revoke all on public.private_imports,public.resource_archive_versions,public.private_resource_bindings,public.private_revision_resource_bindings,public.project_origins,public.resource_origins,public.private_import_cleanup from public,anon,authenticated,service_role;
grant select on public.private_imports,public.resource_archive_versions,public.private_resource_bindings,public.private_revision_resource_bindings,public.project_origins,public.resource_origins,public.private_import_cleanup to service_role;
grant select on public.resource_archive_versions,public.private_resource_bindings,public.private_revision_resource_bindings,public.project_origins,public.resource_origins to authenticated;
create policy archive_version_read on public.resource_archive_versions for select to authenticated using(exists(select 1 from public.resource_versions v join public.resources r on r.id=v.resource_id where v.id=version_id and r.owner_id=auth.uid()));
create policy binding_read on public.private_resource_bindings for select to authenticated using(exists(select 1 from public.projects p where p.id=project_id and p.owner_id=auth.uid()));
create policy revision_binding_read on public.private_revision_resource_bindings for select to authenticated using(exists(select 1 from public.project_revisions v join public.projects p on p.id=v.project_id where v.id=revision_id and p.owner_id=auth.uid()));
create policy project_origin_read on public.project_origins for select to authenticated using(exists(select 1 from public.projects p where p.id=project_id and p.owner_id=auth.uid()));
create policy resource_origin_read on public.resource_origins for select to authenticated using(exists(select 1 from public.resource_versions v join public.resources r on r.id=v.resource_id where v.id=version_id and r.owner_id=auth.uid()));
insert into storage.buckets(id,name,public,file_size_limit) values('authoring-imports','authoring-imports',false,33554432) on conflict(id) do nothing;
-- Deliberately no authenticated Storage policy. Only the service can access an import's object.

create function public.private_import_envelope(p_item public.private_imports) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('importId',p_item.id,'requestId',p_item.request_id,'releaseId',p_item.release_id,'state',p_item.state,
    'storage',jsonb_build_object('bucket','authoring-imports','path',p_item.storage_path,'bytes',p_item.artifact_bytes,'sha256',p_item.artifact_sha256),
    'resolution',p_item.resolution,'receipt',p_item.receipt)
$$;
revoke all on function public.private_import_envelope(public.private_imports) from public,anon,authenticated;

-- These row locks serialize a final commit against moderation and all independently revocable keys.
-- A revocation winning the lock is observed; one arriving later waits until the copy transaction ends.
create function public.lock_private_copy_source(p_release uuid) returns void language plpgsql security definer set search_path='' as $$
declare item public.public_releases; delivery public.publication_delivery_artifacts; scan public.publication_scans; source_submission uuid;
begin
  select submission_id into source_submission from public.public_releases where id=p_release;
  -- Publication writes lock submission before release. Use the same order and recheck identity.
  perform id from public.publication_submissions where id=source_submission for share;
  select * into item from public.public_releases where id=p_release for share;
  if item.id is null then raise exception 'DELIVERY_NOT_AVAILABLE'; end if;
  if item.submission_id is distinct from source_submission then raise exception 'DELIVERY_NOT_AVAILABLE'; end if;
  perform submission_id from public.publication_candidates where submission_id=item.submission_id for share;
  select * into scan from public.publication_scans where submission_id=item.submission_id for share;
  perform id from public.publication_reviews where submission_id=item.submission_id for share;
  select * into delivery from public.publication_delivery_artifacts where release_id=p_release for share;
  perform key_id from public.publication_signing_keys where key_id=delivery.signing_key_id for share;
  perform key_id from public.publication_rights_authorities where key_id=scan.evidence#>>'{rightsEvidence,signature,keyId}' for share;
  perform evidence_sha256 from public.publication_copy_rights where release_id=p_release order by evidence_sha256 for share;
  perform key_id from public.publication_copy_authorities where key_id in(select authority_id from public.publication_copy_rights where release_id=p_release) order by key_id for share;
end $$;
revoke all on function public.lock_private_copy_source(uuid) from public,anon,authenticated;

create function public.begin_private_import(p_owner uuid,p_request uuid,p_release uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.private_imports; resolved jsonb; new_id uuid:=gen_random_uuid();
begin
  if p_owner is null or p_request is null or p_release is null then raise exception 'IMPORT_INPUT_INVALID'; end if;
  -- The transaction advisory lock handles the absent-row case without trusting a browser-selected owner.
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text||'/'||p_request::text,0));
  perform id from auth.users where id=p_owner for share;
  if not found then raise exception 'IMPORT_OWNER_UNAVAILABLE'; end if;
  select * into item from public.private_imports where owner_id=p_owner and request_id=p_request for update;
  if found then
    if item.release_id<>p_release then raise exception 'IMPORT_REQUEST_CONFLICT'; end if;
    return public.private_import_envelope(item);
  end if;
  perform public.lock_private_copy_source(p_release);
  resolved:=public.resolve_publication_copy(p_release);
  insert into public.private_imports(id,owner_id,request_id,release_id,resolution,storage_path,artifact_sha256,artifact_bytes)
    values(new_id,p_owner,p_request,p_release,resolved,p_owner::text||'/'||new_id::text||'/'||(resolved#>>'{delivery,artifactSha256}')||'.zip',resolved#>>'{delivery,artifactSha256}',(resolved#>>'{delivery,artifactBytes}')::bigint) returning * into item;
  return public.private_import_envelope(item);
end $$;
revoke all on function public.begin_private_import(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.begin_private_import(uuid,uuid,uuid) to service_role;

-- Closed preparation metadata contains no bytes or arbitrary storage locations. The full schema and
-- descriptor-byte hashes are checked by package-kit; these checks independently enforce DB pins.
create function public.validate_private_preparation(p_item public.private_imports,p_data jsonb) returns void language plpgsql set search_path='' as $$
declare resource jsonb; dependency record; refs jsonb:='{}'; source jsonb;
begin
  if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>4194304
    or exists(select 1 from jsonb_object_keys(p_data) k where k not in('format','source','name','workflow','editor','resources','inventory'))
    or p_data->>'format' is distinct from 'private-authoring-v1' or length(coalesce(p_data->>'name','')) not between 1 and 120
    or jsonb_typeof(p_data->'source') is distinct from 'object' or jsonb_typeof(p_data->'resources') is distinct from 'array'
    or jsonb_typeof(p_data->'inventory') is distinct from 'object'
  then raise exception 'IMPORT_PREPARATION_INVALID'; end if;
  source:=p_data->'source';
  if source->>'artifactSha256' is distinct from p_item.artifact_sha256 or source->>'manifestSha256' is distinct from p_item.resolution#>>'{delivery,manifestSha256}'
    or source->>'host' is distinct from p_item.resolution#>>'{delivery,targetHost}' or source->>'trust' is distinct from 'verified'
    or coalesce(source->>'kind','') not in('workflow','materials') or coalesce(source->>'packageId','')='' or coalesce(source->>'packageVersion','')=''
    or (select array_agg(k order by k) from jsonb_object_keys(source) k) is distinct from array['artifactSha256','host','kind','manifestSha256','packageId','packageVersion','trust']::text[]
    or jsonb_array_length(p_data->'resources')>2000
    or (p_data#>>'{inventory,resourceCount}') is distinct from jsonb_array_length(p_data->'resources')::text
    or coalesce(p_data#>>'{inventory,fileCount}','') !~ '^\d+$' or coalesce(p_data#>>'{inventory,bytes}','') !~ '^\d+$'
    or (p_data#>>'{inventory,fileCount}')::numeric>2000 or (p_data#>>'{inventory,bytes}')::numeric>67108864
  then raise exception 'IMPORT_PREPARATION_INVALID'; end if;
  if source->>'kind'='workflow' then
    if jsonb_typeof(p_data->'workflow') is distinct from 'object' or jsonb_typeof(p_data#>'{workflow,resources}') is distinct from 'object' then raise exception 'IMPORT_PREPARATION_INVALID'; end if;
  elsif p_data ? 'workflow' or p_data ? 'editor' then raise exception 'IMPORT_PREPARATION_INVALID'; end if;
  if p_data ? 'editor' and (jsonb_typeof(p_data->'editor')<>'object' or octet_length((p_data->'editor')::text)>1048576) then raise exception 'IMPORT_PREPARATION_INVALID'; end if;
  for resource in select value from jsonb_array_elements(p_data->'resources') loop
    if jsonb_typeof(resource)<>'object' or (select array_agg(k order by k) from jsonb_object_keys(resource) k) is distinct from array['alias','contentSha256','descriptor','reference']::text[]
      or coalesce(resource->>'alias','') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' or refs ? (resource->>'alias')
      or jsonb_typeof(resource->'reference') is distinct from 'object' or jsonb_typeof(resource->'descriptor') is distinct from 'object'
      or coalesce(resource->>'contentSha256','') !~ '^[a-f0-9]{64}$'
    then raise exception 'IMPORT_RESOURCE_INVALID'; end if;
    if (select array_agg(k order by k) from jsonb_object_keys(resource->'reference') k) is distinct from array['id','kind','revision','sha256']::text[]
      or coalesce(resource#>>'{reference,id}','') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
      or coalesce(resource#>>'{reference,sha256}','') !~ '^[a-f0-9]{64}$' or coalesce(resource#>>'{reference,revision}','') !~ '^[1-9]\d*$'
      or coalesce(resource#>>'{reference,kind}','') not in('mcp','instruction','document','skill')
      or resource#>'{reference,id}' is distinct from resource#>'{descriptor,id}'
      or resource#>'{reference,revision}' is distinct from resource#>'{descriptor,revision}'
      or resource#>'{reference,kind}' is distinct from resource#>'{descriptor,kind}'
      or length(coalesce(resource#>>'{descriptor,name}','')) not between 1 and 200
      or jsonb_typeof(resource#>'{descriptor,dependencies}') is distinct from 'object'
      or jsonb_typeof(resource#>'{descriptor,license}') is distinct from 'object'
    then raise exception 'IMPORT_RESOURCE_INVALID'; end if;
    refs:=refs||jsonb_build_object(resource->>'alias',resource->'reference');
  end loop;
  for resource in select value from jsonb_array_elements(p_data->'resources') loop
    for dependency in select * from jsonb_each(resource#>'{descriptor,dependencies}') loop
      if refs->dependency.key is distinct from dependency.value then raise exception 'IMPORT_DEPENDENCY_INVALID'; end if;
    end loop;
  end loop;
  if source->>'kind'='workflow' and p_data#>'{workflow,resources}' is distinct from refs then raise exception 'IMPORT_RESOURCE_INVALID'; end if;
  if source->>'kind'='materials' and refs='{}'::jsonb then raise exception 'IMPORT_RESOURCE_INVALID'; end if;
end $$;
revoke all on function public.validate_private_preparation(public.private_imports,jsonb) from public,anon,authenticated;

create function public.stage_private_import(p_import uuid,p_preparation jsonb,p_preparation_sha text,p_stored_bytes bigint,p_stored_sha text) returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.private_imports;
begin
  select * into item from public.private_imports where id=p_import for update;
  if item.id is null or item.owner_id is null then raise exception 'IMPORT_NOT_AVAILABLE'; end if;
  if p_preparation_sha is null or p_preparation_sha !~ '^[a-f0-9]{64}$' or p_stored_bytes is distinct from item.artifact_bytes or p_stored_sha is distinct from item.artifact_sha256 then raise exception 'IMPORT_STORAGE_MISMATCH'; end if;
  if item.preparation is not null and (item.preparation is distinct from p_preparation or item.preparation_sha256 is distinct from p_preparation_sha) then raise exception 'IMPORT_PREPARATION_CONFLICT'; end if;
  if item.state='committed' then return public.private_import_envelope(item); end if;
  if item.state<>'staging' or item.expires_at<=clock_timestamp() then raise exception 'IMPORT_NOT_AVAILABLE'; end if;
  perform public.validate_private_preparation(item,p_preparation);
  update public.private_imports set preparation=p_preparation,preparation_sha256=p_preparation_sha,stored_at=coalesce(stored_at,clock_timestamp()),updated_at=clock_timestamp() where id=p_import returning * into item;
  return public.private_import_envelope(item);
end $$;
revoke all on function public.stage_private_import(uuid,jsonb,text,bigint,text) from public,anon,authenticated;
grant execute on function public.stage_private_import(uuid,jsonb,text,bigint,text) to service_role;

-- Shared relational validation for saves and snapshots. Text descriptor hashes are recomputed by
-- the export server, whereas archive refs can be compared directly with immutable import pins.
create function public.replace_private_bindings(p_project uuid,p_owner uuid,p_workflow jsonb,p_bindings jsonb) returns void language plpgsql set search_path='' as $$
declare binding record; ref jsonb; version public.resource_versions; resource public.resources; archive public.resource_archive_versions; dependency record;
begin
  if jsonb_typeof(p_workflow) is distinct from 'object' or jsonb_typeof(p_bindings) is distinct from 'object'
    or jsonb_typeof(coalesce(p_workflow->'resources','{}'::jsonb)) is distinct from 'object'
    or (select coalesce(array_agg(k order by k),array[]::text[]) from jsonb_object_keys(p_bindings) k) is distinct from (select coalesce(array_agg(k order by k),array[]::text[]) from jsonb_object_keys(coalesce(p_workflow->'resources','{}'::jsonb)) k)
  then raise exception 'RESOURCE_BINDINGS_INVALID'; end if;
  delete from public.private_resource_bindings where project_id=p_project;
  for binding in select * from jsonb_each_text(p_bindings) loop
    if binding.key !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' or binding.value !~ '^[a-fA-F0-9-]{36}$' then raise exception 'RESOURCE_BINDINGS_INVALID'; end if;
    select * into version from public.resource_versions where id=binding.value::uuid for share;
    select * into resource from public.resources where id=version.resource_id and owner_id=p_owner for share;
    if version.id is null or resource.id is null then raise exception 'RESOURCE_BINDINGS_INVALID'; end if;
    ref:=p_workflow->'resources'->binding.key;
    select * into archive from public.resource_archive_versions where version_id=version.id;
    if found then
      if archive.reference is distinct from ref or archive.source_alias<>binding.key then raise exception 'RESOURCE_BINDINGS_INVALID'; end if;
      for dependency in select * from jsonb_each(archive.descriptor->'dependencies') loop
        if p_workflow->'resources'->dependency.key is distinct from dependency.value then raise exception 'RESOURCE_DEPENDENCY_INVALID'; end if;
      end loop;
    elsif version.content->>'format'='archive_v1' or binding.key<>resource.id::text or ref->>'id' is distinct from resource.id::text or ref->>'kind' is distinct from resource.kind
      or ref->>'revision' is distinct from version.revision::text or coalesce(ref->>'sha256','') !~ '^[a-f0-9]{64}$'
    then raise exception 'RESOURCE_BINDINGS_INVALID'; end if;
    insert into public.private_resource_bindings values(p_project,binding.key,version.id,ref);
  end loop;
end $$;
revoke all on function public.replace_private_bindings(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;

create function public.commit_private_import(p_import uuid,p_preparation_sha text) returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.private_imports; resolved jsonb; source jsonb; resource jsonb; content jsonb; resource_id uuid; version_id uuid; project_id uuid; workflow jsonb; bindings jsonb:='{}'; results jsonb:='[]';
begin
  select * into item from public.private_imports where id=p_import for update;
  if item.id is null or item.owner_id is null then raise exception 'IMPORT_NOT_AVAILABLE'; end if;
  if p_preparation_sha is null or item.preparation_sha256 is distinct from p_preparation_sha then raise exception 'IMPORT_PREPARATION_CONFLICT'; end if;
  if item.state='committed' then return public.private_import_envelope(item); end if;
  if item.state<>'staging' or item.preparation is null or item.stored_at is null then raise exception 'IMPORT_NOT_AVAILABLE'; end if;
  perform id from auth.users where id=item.owner_id for share;
  if not found then raise exception 'IMPORT_OWNER_UNAVAILABLE'; end if;
  perform public.lock_private_copy_source(item.release_id);
  resolved:=public.resolve_publication_copy(item.release_id);
  -- Replacements of evidence require a new request: an in-flight copy cannot silently change its authorization.
  if resolved is distinct from item.resolution then raise exception 'IMPORT_SOURCE_CHANGED'; end if;
  if item.expires_at<=clock_timestamp() then raise exception 'IMPORT_NOT_AVAILABLE'; end if;
  perform public.validate_private_preparation(item,item.preparation);
  source:=jsonb_build_object('releaseId',item.release_id,'sourceSnapshotSha256',resolved#>>'{delivery,sourceSnapshotSha256}',
    'package',item.preparation->'source','title',item.preparation->>'name','copyEvidenceSha256',resolved#>>'{copyRights,evidenceSha256}');
  for resource in select value from jsonb_array_elements(item.preparation->'resources') loop
    content:=jsonb_build_object('format','archive_v1','importId',item.id,'sourceAlias',resource->>'alias','reference',resource->'reference',
      'descriptorSha256',resource#>>'{reference,sha256}','name',resource#>>'{descriptor,name}','kind',resource#>>'{descriptor,kind}','description','');
    insert into public.resources(owner_id,name,kind) values(item.owner_id,resource#>>'{descriptor,name}',resource#>>'{descriptor,kind}') returning id into resource_id;
    insert into public.resource_versions(resource_id,revision,content,sha256) values(resource_id,1,content,resource->>'contentSha256') returning id into version_id;
    insert into public.resource_archive_versions values(version_id,item.id,resource->>'alias',resource->'reference',resource->'descriptor');
    insert into public.resource_origins(version_id,import_id,source) values(version_id,item.id,source||jsonb_build_object('alias',resource->>'alias','license',resource#>'{descriptor,license}','files',resource#>'{descriptor,files}'));
    bindings:=bindings||jsonb_build_object(resource->>'alias',version_id);
    results:=results||jsonb_build_array(jsonb_build_object('alias',resource->>'alias','resourceId',resource_id,'versionId',version_id,'revision',1));
  end loop;
  if item.preparation#>>'{source,kind}'='workflow' then
    insert into public.projects(owner_id,name) values(item.owner_id,item.preparation->>'name') returning id into project_id;
    workflow:=item.preparation->'workflow'||jsonb_build_object('id',gen_random_uuid()::text,'revision',1);
    insert into public.project_drafts(project_id,workflow,editor) values(project_id,workflow,coalesce(item.preparation->'editor','{}'));
    perform public.replace_private_bindings(project_id,item.owner_id,workflow,bindings);
    insert into public.project_origins(project_id,import_id,source) values(project_id,item.id,source);
  end if;
  update public.private_imports set state='committed',receipt=jsonb_build_object('importId',item.id,'projectId',project_id,'resources',results),updated_at=clock_timestamp() where id=item.id returning * into item;
  insert into public.publication_audit(release_id,action,detail) values(item.release_id,'private_copy_committed',jsonb_build_object('importId',item.id,'resourceCount',jsonb_array_length(results)));
  return public.private_import_envelope(item);
end $$;
revoke all on function public.commit_private_import(uuid,text) from public,anon,authenticated;
grant execute on function public.commit_private_import(uuid,text) to service_role;

create function public.fail_private_import(p_import uuid,p_code text) returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.private_imports;
begin
  if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{0,79}$' then raise exception 'IMPORT_FAILURE_INVALID'; end if;
  select * into item from public.private_imports where id=p_import for update;
  if item.id is null then raise exception 'IMPORT_NOT_AVAILABLE'; end if;
  if item.state='committed' then raise exception 'IMPORT_ALREADY_COMMITTED'; end if;
  if item.state='staging' then
    update public.private_imports set state='failed',failure_code=p_code,updated_at=clock_timestamp() where id=p_import returning * into item;
  end if;
  insert into public.private_import_cleanup(import_id,storage_path,expected_sha256,not_before) values(item.id,item.storage_path,item.artifact_sha256,clock_timestamp()+interval '7 days') on conflict(import_id) do nothing;
  return public.private_import_envelope(item);
end $$;
revoke all on function public.fail_private_import(uuid,text) from public,anon,authenticated;
grant execute on function public.fail_private_import(uuid,text) to service_role;

create function public.get_private_import_status(p_request uuid) returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('importId',id,'requestId',request_id,'releaseId',release_id,'state',state,'receipt',receipt,'failureCode',failure_code)
  from public.private_imports where owner_id=auth.uid() and request_id=p_request
$$;
revoke all on function public.get_private_import_status(uuid) from public,anon;
grant execute on function public.get_private_import_status(uuid) to authenticated;

-- Close all write bypasses before exposing the atomic authoring RPCs. Existing read policies remain.
revoke insert,update,delete on public.project_drafts from authenticated;
revoke insert on public.project_revisions from authenticated;
drop policy resource_version_insert on public.resource_versions;
create policy resource_version_insert on public.resource_versions for insert to authenticated with check(
  content->>'format' is distinct from 'archive_v1' and exists(select 1 from public.resources r where r.id=resource_id and r.owner_id=auth.uid()));

create function public.infer_private_bindings(p_project uuid,p_owner uuid,p_workflow jsonb) returns jsonb language plpgsql set search_path='' as $$
declare ref record; result jsonb:='{}'; version_id uuid;
begin
  if jsonb_typeof(p_workflow) is distinct from 'object' or jsonb_typeof(coalesce(p_workflow->'resources','{}'::jsonb)) is distinct from 'object' then raise exception 'RESOURCE_BINDINGS_INVALID'; end if;
  for ref in select * from jsonb_each(coalesce(p_workflow->'resources','{}'::jsonb)) loop
    version_id:=null;
    select b.version_id into version_id from public.private_resource_bindings b where b.project_id=p_project and b.alias=ref.key and b.reference=ref.value;
    if version_id is null then
      select v.id into version_id from public.resource_versions v join public.resources r on r.id=v.resource_id
        where r.owner_id=p_owner and r.id::text=ref.key and r.id::text=ref.value->>'id' and r.kind=ref.value->>'kind'
        and v.revision::text=ref.value->>'revision' and v.content->>'format' is distinct from 'archive_v1';
    end if;
    if version_id is null then raise exception 'RESOURCE_BINDINGS_REQUIRED'; end if;
    result:=result||jsonb_build_object(ref.key,version_id);
  end loop;
  return result;
end $$;
revoke all on function public.infer_private_bindings(uuid,uuid,jsonb) from public,anon,authenticated;

create or replace function public.create_private_project(p_name text,p_workflow jsonb,p_editor jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare project public.projects; draft public.project_drafts;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  insert into public.projects(owner_id,name) values(auth.uid(),p_name) returning * into project;
  insert into public.project_drafts(project_id,workflow,editor) values(project.id,p_workflow,p_editor) returning * into draft;
  perform public.replace_private_bindings(project.id,auth.uid(),p_workflow,public.infer_private_bindings(project.id,auth.uid(),p_workflow));
  return jsonb_build_object('project',to_jsonb(project),'draft',to_jsonb(draft));
end $$;
-- New account projects may explicitly reuse already-owned archive versions without renaming aliases.
create function public.create_private_project_with_resources(p_name text,p_workflow jsonb,p_editor jsonb,p_bindings jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare project public.projects; draft public.project_drafts;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  insert into public.projects(owner_id,name) values(auth.uid(),p_name) returning * into project;
  insert into public.project_drafts(project_id,workflow,editor) values(project.id,p_workflow,p_editor) returning * into draft;
  perform public.replace_private_bindings(project.id,auth.uid(),p_workflow,p_bindings);
  return jsonb_build_object('project',to_jsonb(project),'draft',to_jsonb(draft));
end $$;
revoke all on function public.create_private_project_with_resources(text,jsonb,jsonb,jsonb) from public,anon;
grant execute on function public.create_private_project_with_resources(text,jsonb,jsonb,jsonb) to authenticated;
create function public.save_private_draft_with_resources(p_project_id uuid,p_expected_version integer,p_name text,p_workflow jsonb,p_editor jsonb,p_bindings jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare draft public.project_drafts;
begin
  perform id from public.projects where id=p_project_id and owner_id=auth.uid() for update;
  if not found then raise exception 'DRAFT_VERSION_CONFLICT' using errcode='40001'; end if;
  select * into draft from public.project_drafts where project_id=p_project_id for update;
  if draft.project_id is null or draft.version is distinct from p_expected_version then raise exception 'DRAFT_VERSION_CONFLICT' using errcode='40001'; end if;
  perform public.replace_private_bindings(p_project_id,auth.uid(),p_workflow,p_bindings);
  update public.project_drafts set workflow=p_workflow,editor=p_editor,version=version+1,updated_at=clock_timestamp() where project_id=p_project_id returning * into draft;
  update public.projects set name=p_name,updated_at=clock_timestamp() where id=p_project_id;
  return to_jsonb(draft);
end $$;
revoke all on function public.save_private_draft_with_resources(uuid,integer,text,jsonb,jsonb,jsonb) from public,anon;
grant execute on function public.save_private_draft_with_resources(uuid,integer,text,jsonb,jsonb,jsonb) to authenticated;

create or replace function public.save_private_draft(p_project_id uuid,p_expected_version integer,p_name text,p_workflow jsonb,p_editor jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  -- Lock the project before reading the old map so legacy saves cannot race a changed archive binding.
  perform id from public.projects where id=p_project_id and owner_id=auth.uid() for update;
  if not found then raise exception 'DRAFT_VERSION_CONFLICT' using errcode='40001'; end if;
  return public.save_private_draft_with_resources(p_project_id,p_expected_version,p_name,p_workflow,p_editor,public.infer_private_bindings(p_project_id,auth.uid(),p_workflow));
end $$;
create or replace function public.snapshot_private_project(p_project_id uuid,p_expected_version integer,p_sha256 text) returns jsonb language plpgsql security definer set search_path='' as $$
declare draft public.project_drafts; revision public.project_revisions; next_revision integer;
begin
  perform id from public.projects where id=p_project_id and owner_id=auth.uid() for update;
  if not found then raise exception 'DRAFT_VERSION_CONFLICT' using errcode='40001'; end if;
  select * into draft from public.project_drafts where project_id=p_project_id for update;
  if draft.project_id is null or draft.version is distinct from p_expected_version then raise exception 'DRAFT_VERSION_CONFLICT' using errcode='40001'; end if;
  -- Backfill bindings for pre-010 text-only drafts, while preserving pinned archive versions.
  perform public.replace_private_bindings(p_project_id,auth.uid(),draft.workflow,public.infer_private_bindings(p_project_id,auth.uid(),draft.workflow));
  select coalesce(max(r.revision),0)+1 into next_revision from public.project_revisions r where r.project_id=p_project_id;
  insert into public.project_revisions(project_id,revision,workflow,editor,sha256) values(p_project_id,next_revision,draft.workflow,draft.editor,p_sha256) returning * into revision;
  insert into public.private_revision_resource_bindings select revision.id,alias,version_id,reference from public.private_resource_bindings where project_id=p_project_id;
  return to_jsonb(revision);
end $$;
revoke all on function public.create_private_project(text,jsonb,jsonb),public.save_private_draft(uuid,integer,text,jsonb,jsonb),public.snapshot_private_project(uuid,integer,text) from public,anon;
grant execute on function public.create_private_project(text,jsonb,jsonb),public.save_private_draft(uuid,integer,text,jsonb,jsonb),public.snapshot_private_project(uuid,integer,text) to authenticated;

-- A claim is a lease on one exact object. Unknown Storage outcomes are retried; only confirmed
-- deletion/404 finishes it. Staging becomes terminal failed before any deletion can be claimed.
create function public.claim_private_import_cleanup(p_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.private_imports; job public.private_import_cleanup; results jsonb:='[]'; checked_at timestamptz:=clock_timestamp();
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'CLEANUP_LIMIT_INVALID'; end if;
  for item in select * from public.private_imports where state='staging' and (expires_at<=checked_at or owner_id is null) order by id for update skip locked limit p_limit loop
    perform public.fail_private_import(item.id,'IMPORT_EXPIRED');
  end loop;
  -- An orphaned committed archive becomes collectible only when no project origin or resource
  -- version retains it. A surviving revision prevents deletion of its referenced resource version.
  insert into public.private_import_cleanup(import_id,storage_path,expected_sha256,not_before)
    select i.id,i.storage_path,i.artifact_sha256,checked_at+interval '7 days' from public.private_imports i
    where i.state='committed' and i.storage_deleted_at is null
      and not exists(select 1 from public.project_origins p where p.import_id=i.id)
      and not exists(select 1 from public.resource_archive_versions r where r.import_id=i.id)
    on conflict(import_id) do nothing;
  for job in select * from public.private_import_cleanup where finished_at is null and not_before<=checked_at and (lease_until is null or lease_until<=checked_at) order by not_before,id for update skip locked limit p_limit loop
    select * into item from public.private_imports where id=job.import_id for update;
    if item.state='staging' or exists(select 1 from public.resource_archive_versions where import_id=item.id) or exists(select 1 from public.project_origins where import_id=item.id) then continue; end if;
    update public.private_import_cleanup set lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes',attempts=attempts+1 where id=job.id returning * into job;
    results:=results||jsonb_build_array(jsonb_build_object('jobId',job.id,'importId',job.import_id,'leaseId',job.lease_id,'bucket','authoring-imports','path',job.storage_path,'expectedSha256',job.expected_sha256,'attempts',job.attempts));
  end loop;
  return results;
end $$;
create function public.finish_private_import_cleanup(p_job uuid,p_lease uuid,p_outcome text) returns void language plpgsql security definer set search_path='' as $$
declare job public.private_import_cleanup;
begin
  select * into job from public.private_import_cleanup where id=p_job for update;
  if job.id is null or p_lease is null or job.lease_id is null or job.lease_until is null or job.lease_id is distinct from p_lease then raise exception 'CLEANUP_LEASE_INVALID'; end if;
  if job.finished_at is not null then
    if job.last_outcome=p_outcome then return; else raise exception 'CLEANUP_OUTCOME_CONFLICT'; end if;
  end if;
  if job.lease_until<=clock_timestamp() then raise exception 'CLEANUP_LEASE_INVALID'; end if;
  if p_outcome in('deleted','not_found') then
    update public.private_import_cleanup set finished_at=clock_timestamp(),last_outcome=p_outcome where id=p_job;
    update public.private_imports set storage_deleted_at=clock_timestamp() where id=job.import_id;
  elsif p_outcome='retry' then
    update public.private_import_cleanup set last_outcome=p_outcome,lease_id=null,lease_until=null,not_before=clock_timestamp()+interval '1 hour' where id=p_job;
  else raise exception 'CLEANUP_OUTCOME_INVALID'; end if;
end $$;
revoke all on function public.claim_private_import_cleanup(integer),public.finish_private_import_cleanup(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_private_import_cleanup(integer),public.finish_private_import_cleanup(uuid,uuid,text) to service_role;

-- Preserve pre-migration text-only authoring. Existing JSON and snapshot hashes are never rewritten.
-- Invalid or unowned historical references remain unresolved rather than being certified by migration.
insert into public.private_resource_bindings(project_id,alias,version_id,reference)
  select d.project_id,ref.key,v.id,ref.value from public.project_drafts d
  join public.projects p on p.id=d.project_id
  cross join lateral jsonb_each(case when jsonb_typeof(d.workflow->'resources')='object' then d.workflow->'resources' else '{}'::jsonb end) ref
  join public.resources r on r.id::text=ref.key and r.owner_id=p.owner_id
  join public.resource_versions v on v.resource_id=r.id and v.revision::text=ref.value->>'revision'
  where ref.value->>'id'=r.id::text and ref.value->>'kind'=r.kind and ref.value->>'sha256' ~ '^[a-f0-9]{64}$'
    and v.content->>'format' is distinct from 'archive_v1';
insert into public.private_revision_resource_bindings(revision_id,alias,version_id,reference)
  select snapshot.id,ref.key,v.id,ref.value from public.project_revisions snapshot
  join public.projects p on p.id=snapshot.project_id
  cross join lateral jsonb_each(case when jsonb_typeof(snapshot.workflow->'resources')='object' then snapshot.workflow->'resources' else '{}'::jsonb end) ref
  join public.resources r on r.id::text=ref.key and r.owner_id=p.owner_id
  join public.resource_versions v on v.resource_id=r.id and v.revision::text=ref.value->>'revision'
  where ref.value->>'id'=r.id::text and ref.value->>'kind'=r.kind and ref.value->>'sha256' ~ '^[a-f0-9]{64}$'
    and v.content->>'format' is distinct from 'archive_v1';
