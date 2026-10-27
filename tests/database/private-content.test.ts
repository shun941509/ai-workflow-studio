import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Execute the real migration in PostgreSQL WASM. Auth/Storage helpers below are test boundaries, not live Supabase evidence. */
describe('private-content PostgreSQL policies', () => {
  const owner = '10000000-0000-4000-8000-000000000001';
  const stranger = '20000000-0000-4000-8000-000000000002';
  let database: PGlite;
  let projectId: string;
  beforeAll(async () => {
    database = await PGlite.create();
    await database.exec(`
      create role authenticated; create role anon;
      create schema auth; create schema storage;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
      create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
      alter table storage.objects enable row level security;
      grant usage on schema public,auth,storage to authenticated,anon;
      grant select,insert,update,delete on storage.objects to authenticated;
      insert into auth.users values ('${owner}'),('${stranger}');
    `);
    await database.exec(await readFile(new URL('../../infrastructure/supabase/migrations/001-private-content.sql', import.meta.url), 'utf8'));
    await database.exec('set role authenticated');
    await database.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    const created = await database.query<{ result: { project: { id: string } } }>("select public.create_private_project($1,$2::jsonb,$3::jsonb) as result", ['Owner project', '{}', '{}']);
    projectId = created.rows[0]!.result.project.id;
  }, 30000);
  afterAll(async () => { await database?.close(); });

  it('saves an owner draft atomically and rejects stale saves', async () => {
    const saved = await database.query<{ result: { version: number } }>('select public.save_private_draft($1,1,$2,$3::jsonb,$4::jsonb) as result', [projectId, 'Renamed', '{"name":"saved"}', '{}']);
    expect(saved.rows[0]!.result.version).toBe(2);
    await expect(database.query('select public.save_private_draft($1,1,$2,$3::jsonb,$4::jsonb)', [projectId, 'Stale overwrite', '{}', '{}'])).rejects.toMatchObject({ code: '40001' });
    const row = await database.query<{ name: string }>('select name from public.projects where id=$1', [projectId]);
    expect(row.rows[0]!.name).toBe('Renamed');
  });
  it('keeps a project revision immutable', async () => {
    await database.query('select public.snapshot_private_project($1,2,$2)', [projectId, 'a'.repeat(64)]);
    await expect(database.query('update public.project_revisions set workflow=$1::jsonb where project_id=$2', ['{"tampered":true}', projectId])).rejects.toMatchObject({ code: '42501' });
    await expect(database.query('delete from public.project_revisions where project_id=$1', [projectId])).rejects.toMatchObject({ code: '42501' });
  });
  it('denies another user both reads and writes, including Storage paths', async () => {
    const resource = await database.query<{ result: { resource: { id: string } } }>('select public.create_private_resource($1,$2,$3,$4::jsonb,$5) as result', ['Owner material', 'instruction', '', '{}', 'b'.repeat(64)]);
    const resourceId = resource.rows[0]!.result.resource.id;
    const storagePath = `${owner}/${resourceId}/instructions.md`;
    await database.query("insert into storage.objects(bucket_id,name) values('resources',$1)", [storagePath]);
    await database.query("select set_config('request.jwt.claim.sub',$1,false)", [stranger]);
    for (const table of ['projects', 'project_drafts', 'project_revisions', 'resources', 'resource_versions']) expect((await database.query(`select * from public.${table}`)).rows).toEqual([]);
    expect((await database.query('select * from storage.objects')).rows).toEqual([]);
    await expect(database.query('select public.save_private_draft($1,2,$2,$3::jsonb,$4::jsonb)', [projectId, 'Foreign overwrite', '{}', '{}'])).rejects.toMatchObject({ code: '40001' });
    await expect(database.query("insert into storage.objects(bucket_id,name) values('resources',$1)", [storagePath])).rejects.toMatchObject({ code: '42501' });
    await expect(database.query('insert into public.projects(owner_id,name) values($1,$2)', [owner, 'Forged owner'])).rejects.toMatchObject({ code: '42501' });
  });
  it('does not grant anonymous RPC execution', async () => {
    await database.exec('reset role; set role anon');
    await database.query("select set_config('request.jwt.claim.sub','',false)");
    await expect(database.query("select public.create_private_project('anonymous','{}'::jsonb,'{}'::jsonb)")).rejects.toMatchObject({ code: '42501' });
  });
});
