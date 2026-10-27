import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

/** Only Auth identity injection and Storage helpers are fixtures; the application migrations run unchanged in PostgreSQL. */
export async function createPolicyDatabase(users: string[]): Promise<PGlite> {
  const database = await PGlite.create();
  await database.exec(`
    create role authenticated; create role anon; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
    create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
    alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon,service_role;
    grant select,insert,update,delete on storage.objects to authenticated;
  `);
  for (const id of users) await database.query('insert into auth.users(id) values($1)', [id]);
  await database.exec(await readFile(new URL('../../infrastructure/supabase/migrations/001-private-content.sql', import.meta.url), 'utf8'));
  return database;
}

/** Role selection stays in the trusted test harness, never an application RPC or browser parameter. */
export async function asUser(database: PGlite, id: string): Promise<void> {
  await database.exec('reset role; set role authenticated');
  await database.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
}
