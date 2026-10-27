-- Run only against an isolated Supabase test database with two existing Auth users.
-- psql variables user_a/user_b must be real UUIDs provisioned by the test harness; this file creates no account.
-- Every write is rolled back. An unavailable database is unverified, never a passing RLS result.
\set ON_ERROR_STOP on
begin;
select set_config('studio.test.user_a', :'user_a', true);
select set_config('studio.test.user_b', :'user_b', true);
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('studio.test.user_a'), true);
select set_config('request.jwt.claims', json_build_object('sub',current_setting('studio.test.user_a'),'role','authenticated')::text, true);

-- The RPC checks ownership through RLS and atomically creates both rows.
select set_config('studio.test.project', (public.create_private_project('RLS isolated test','{"schemaVersion":"1.0.0"}'::jsonb,'{}'::jsonb)->'project'->>'id'), true);
do $$ begin
  if not exists(select 1 from public.project_drafts where project_id=current_setting('studio.test.project')::uuid and version=1) then raise exception 'Owner cannot read initial draft'; end if;
end $$;
select public.save_private_draft(current_setting('studio.test.project')::uuid,1,'RLS isolated test','{"schemaVersion":"1.0.0"}'::jsonb,'{}'::jsonb);
do $$ begin
  begin
    perform public.save_private_draft(current_setting('studio.test.project')::uuid,1,'stale overwrite','{}'::jsonb,'{}'::jsonb);
    raise exception 'Stale version incorrectly accepted';
  exception when serialization_failure then null;
  end;
end $$;
select public.snapshot_private_project(current_setting('studio.test.project')::uuid,2,repeat('a',64));

-- A second authenticated user cannot discover, read, edit or snapshot the first user's objects.
select set_config('request.jwt.claim.sub', current_setting('studio.test.user_b'), true);
select set_config('request.jwt.claims', json_build_object('sub',current_setting('studio.test.user_b'),'role','authenticated')::text, true);
do $$ begin
  if exists(select 1 from public.projects where id=current_setting('studio.test.project')::uuid) then raise exception 'Cross-owner project read'; end if;
  if exists(select 1 from public.project_drafts where project_id=current_setting('studio.test.project')::uuid) then raise exception 'Cross-owner draft read'; end if;
  if exists(select 1 from public.project_revisions where project_id=current_setting('studio.test.project')::uuid) then raise exception 'Cross-owner revision read'; end if;
  begin
    perform public.save_private_draft(current_setting('studio.test.project')::uuid,2,'foreign overwrite','{}'::jsonb,'{}'::jsonb);
    raise exception 'Cross-owner write accepted';
  exception when serialization_failure then null;
  end;
end $$;
rollback;
