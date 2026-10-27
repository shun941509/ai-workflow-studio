-- Private authoring data is tenant-scoped. No service-role credential is needed in the browser.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (length(display_name) <= 120),
  created_at timestamptz not null default now()
);
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_owner_updated on public.projects(owner_id, updated_at desc);
create table public.project_drafts (
  project_id uuid primary key references public.projects(id) on delete cascade,
  version integer not null default 1 check (version > 0),
  workflow jsonb not null check (jsonb_typeof(workflow) = 'object'),
  editor jsonb not null default '{}'::jsonb check (jsonb_typeof(editor) = 'object'),
  updated_at timestamptz not null default now()
);
create table public.project_revisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  revision integer not null check (revision > 0),
  workflow jsonb not null,
  editor jsonb not null,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique(project_id, revision)
);
create table public.resources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('mcp','instruction','document','skill')),
  name text not null check (length(name) between 1 and 120),
  description text not null default '' check (length(description) <= 2000),
  created_at timestamptz not null default now()
);
create table public.resource_versions (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.resources(id) on delete cascade,
  revision integer not null check (revision > 0),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique(resource_id, revision)
);
create table public.resource_files (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.resource_versions(id) on delete cascade,
  storage_path text not null unique,
  bytes bigint not null check (bytes between 0 and 134217728),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  media_type text not null,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_drafts enable row level security;
alter table public.project_revisions enable row level security;
alter table public.resources enable row level security;
alter table public.resource_versions enable row level security;
alter table public.resource_files enable row level security;

-- Explicit grants avoid relying on an installation's default privileges; RLS remains authoritative.
grant select,insert,update,delete on public.profiles,public.projects,public.project_drafts,public.resources,public.resource_files to authenticated;
revoke update,delete on public.project_revisions,public.resource_versions from authenticated;
grant select,insert on public.project_revisions,public.resource_versions to authenticated;

create policy profile_own on public.profiles for all to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy project_own on public.projects for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy draft_own on public.project_drafts for all to authenticated
  using (exists(select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()))
  with check (exists(select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));
-- Immutable snapshots have insert/select policies only; callers cannot rewrite a published hash.
create policy revision_read on public.project_revisions for select to authenticated
  using (exists(select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));
create policy revision_insert on public.project_revisions for insert to authenticated
  with check (exists(select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));
create policy resource_own on public.resources for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy resource_version_read on public.resource_versions for select to authenticated
  using (exists(select 1 from public.resources r where r.id = resource_id and r.owner_id = auth.uid()));
create policy resource_version_insert on public.resource_versions for insert to authenticated
  with check (exists(select 1 from public.resources r where r.id = resource_id and r.owner_id = auth.uid()));
create policy resource_file_own on public.resource_files for all to authenticated
  using (exists(select 1 from public.resource_versions v join public.resources r on r.id=v.resource_id where v.id=version_id and r.owner_id=auth.uid()))
  with check (exists(select 1 from public.resource_versions v join public.resources r on r.id=v.resource_id where v.id=version_id and r.owner_id=auth.uid()));

-- Security-invoker RPCs retain RLS and atomically update the project and its optimistic draft version.
create function public.create_private_project(p_name text, p_workflow jsonb, p_editor jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare result_project public.projects; result_draft public.project_drafts;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  insert into public.projects(name) values(p_name) returning * into result_project;
  insert into public.project_drafts(project_id, workflow, editor) values(result_project.id,p_workflow,p_editor) returning * into result_draft;
  return jsonb_build_object('project',to_jsonb(result_project),'draft',to_jsonb(result_draft));
end $$;
create function public.save_private_draft(p_project_id uuid, p_expected_version integer, p_name text, p_workflow jsonb, p_editor jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare result_draft public.project_drafts;
begin
  update public.project_drafts set workflow=p_workflow,editor=p_editor,version=version+1,updated_at=now()
    where project_id=p_project_id and version=p_expected_version returning * into result_draft;
  if not found then raise exception 'DRAFT_VERSION_CONFLICT' using errcode='40001'; end if;
  update public.projects set name=p_name,updated_at=now() where id=p_project_id;
  return to_jsonb(result_draft);
end $$;
create function public.snapshot_private_project(p_project_id uuid, p_expected_version integer, p_sha256 text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare source_draft public.project_drafts; result_revision public.project_revisions; next_revision integer;
begin
  select * into source_draft from public.project_drafts where project_id=p_project_id for update;
  if not found or source_draft.version<>p_expected_version then raise exception 'DRAFT_VERSION_CONFLICT' using errcode='40001'; end if;
  select coalesce(max(revision),0)+1 into next_revision from public.project_revisions where project_id=p_project_id;
  insert into public.project_revisions(project_id,revision,workflow,editor,sha256)
    values(p_project_id,next_revision,source_draft.workflow,source_draft.editor,p_sha256) returning * into result_revision;
  return to_jsonb(result_revision);
end $$;
create function public.create_private_resource(p_name text,p_kind text,p_description text,p_content jsonb,p_sha256 text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare result_resource public.resources; result_version public.resource_versions;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  insert into public.resources(name,kind,description) values(p_name,p_kind,p_description) returning * into result_resource;
  insert into public.resource_versions(resource_id,revision,content,sha256) values(result_resource.id,1,p_content,p_sha256) returning * into result_version;
  return jsonb_build_object('resource',to_jsonb(result_resource),'version',to_jsonb(result_version));
end $$;
revoke all on function public.create_private_project(text,jsonb,jsonb),public.save_private_draft(uuid,integer,text,jsonb,jsonb),public.snapshot_private_project(uuid,integer,text),public.create_private_resource(text,text,text,jsonb,text) from public;
grant execute on function public.create_private_project(text,jsonb,jsonb),public.save_private_draft(uuid,integer,text,jsonb,jsonb),public.snapshot_private_project(uuid,integer,text),public.create_private_resource(text,text,text,jsonb,text) to authenticated;

-- Private Storage object paths are owner/resource/file; both path segments are checked against ownership.
insert into storage.buckets(id,name,public,file_size_limit) values('resources','resources',false,134217728) on conflict(id) do nothing;
create policy resource_object_read on storage.objects for select to authenticated using (
  bucket_id='resources' and (storage.foldername(name))[1]=auth.uid()::text and
  exists(select 1 from public.resources r where r.id::text=(storage.foldername(storage.objects.name))[2] and r.owner_id=auth.uid())
);
create policy resource_object_insert on storage.objects for insert to authenticated with check (
  bucket_id='resources' and (storage.foldername(name))[1]=auth.uid()::text and
  exists(select 1 from public.resources r where r.id::text=(storage.foldername(storage.objects.name))[2] and r.owner_id=auth.uid())
);
create policy resource_object_delete on storage.objects for delete to authenticated using (
  bucket_id='resources' and (storage.foldername(name))[1]=auth.uid()::text and
  exists(select 1 from public.resources r where r.id::text=(storage.foldername(storage.objects.name))[2] and r.owner_id=auth.uid())
);
