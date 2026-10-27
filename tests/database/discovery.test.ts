import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createPolicyDatabase } from './postgres-harness.js';

/** Real migrations/RLS run in PostgreSQL; trusted seed rows here do not claim that an artifact passed external review. */
describe('published metadata discovery and reporting boundary', () => {
  const owner = '10000000-0000-4000-8000-000000000001', viewer = '20000000-0000-4000-8000-000000000002', other = '30000000-0000-4000-8000-000000000003';
  const timestamp = '2026-10-27T01:00:00.123456Z'; let database: PGlite; const releases: string[] = []; let official: string; let material: string; let literal: string;
  async function seed(kind: 'project' | 'resource', isOfficial: boolean, title: string) {
    const submission = randomUUID(), release = randomUUID();
    await database.query('insert into public.publication_submissions(id,owner_id,kind,project_revision_id,resource_version_id,source_snapshot,status) values($1,$2,$3,$4,$5,$6,\'published\')', [submission, owner, kind, kind === 'project' ? randomUUID() : null, kind === 'resource' ? randomUUID() : null, { privateSource: 'must not leave owner boundary' }]);
    await database.query('insert into public.public_releases(id,submission_id,owner_id,kind,title,description,artifact_sha256,manifest_sha256,storage_path,is_official,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [release, submission, owner, kind, title, 'Public metadata description', 'a'.repeat(64), 'b'.repeat(64), `releases/private/${release}.zip`, isOfficial, timestamp]);
    return release;
  }
  const search = (kind = 'project', isOfficial = false, query = '', beforeAt: string | null = null, beforeId: string | null = null, limit = 25) => database.query<{ id: string; title: string; kind: string; is_official: boolean }>('select * from public.search_public_releases($1,$2,$3,$4,$5,$6)', [kind, isOfficial, query, beforeAt, beforeId, limit]);
  beforeAll(async () => {
    database = await createPolicyDatabase([owner, viewer, other]);
    for (const name of ['002-publications.sql', '003-public-release-metadata.sql', '004-public-release-search.sql']) await database.exec(await readFile(new URL(`../../infrastructure/supabase/migrations/${name}`, import.meta.url), 'utf8'));
    await database.exec('reset role; set role service_role');
    for (let index = 0; index < 30; index++) releases.push(await seed('project', false, `Search Project ${index}`));
    official = await seed('project', true, 'Official example'); material = await seed('resource', false, 'Community document'); literal = await seed('resource', false, '100%_literal \' example');
    await database.exec('reset role; set role anon');
  }, 30000);
  afterAll(async () => { await database?.close(); });

  it('separates official/community and project/resource collections without exposing private columns', async () => {
    expect((await search('project', true)).rows.map((row) => row.id)).toEqual([official]);
    expect((await search('resource', false, 'Community')).rows.map((row) => row.id)).toEqual([material]);
    const rows = (await search('project', false)).rows; expect(rows).toHaveLength(25); expect(rows.every((row) => row.kind === 'project' && row.is_official === false)).toBe(true);
    expect(Object.keys(rows[0]!).sort()).toEqual(['id', 'kind', 'title', 'description', 'artifact_sha256', 'manifest_sha256', 'status', 'is_official', 'created_at'].sort());
  });

  it('paginates equal microsecond timestamps by a deterministic UUID tie-breaker', async () => {
    const first = (await search()).rows; const second = (await search('project', false, '', timestamp, first.at(-1)!.id)).rows;
    expect(second).toHaveLength(5); expect([...first, ...second].map((row) => row.id)).toEqual([...releases].sort().reverse());
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(30);
  });

  it('treats wildcard and quote text literally rather than executing a filter language', async () => {
    expect((await search('resource', false, "%_literal '")).rows.map((row) => row.id)).toEqual([literal]);
    expect((await search('resource', false, "' OR 1=1 --")).rows).toHaveLength(0);
    expect((await search('project', false, 'sEaRcH pRoJeCt')).rows).toHaveLength(25);
  });

  it('rejects unbounded or incomplete query/cursor parameters in the database itself', async () => {
    for (const args of [['project', false, '', null, null, 0], ['project', false, '', null, null, 26], ['other', false, '', null, null, 1], ['project', null, '', null, null, 1], ['project', false, 'x'.repeat(101), null, null, 1], ['project', false, 'a\nb', null, null, 1], ['project', false, '', timestamp, null, 1], ['project', false, '', null, releases[0], 1], ['project', false, '', 'infinity', releases[0], 1]]) await expect(database.query('select * from public.search_public_releases($1,$2,$3,$4,$5,$6)', args)).rejects.toMatchObject({ code: '22023' });
  });

  it('denies direct private-column reads and release mutations to anonymous and signed-in callers', async () => {
    for (const identity of [null, viewer]) {
      if (identity) await asUser(database, identity); else await database.exec('reset role; set role anon');
      for (const column of ['storage_path', 'owner_id', 'submission_id']) await expect(database.query(`select ${column} from public.public_releases`)).rejects.toMatchObject({ code: '42501' });
      await expect(database.query('update public.public_releases set title=\'forged\' where id=$1', [official])).rejects.toMatchObject({ code: '42501' });
    }
    await database.exec('reset role; set role anon'); await expect(database.query('select source_snapshot from public.publication_submissions')).rejects.toMatchObject({ code: '42501' });
  });

  it('derives reports from the authenticated identity and isolates their contents', async () => {
    await database.exec('reset role; set role anon'); await expect(database.query('select public.report_release($1,$2)', [official, 'A specific report in an isolated database'])).rejects.toMatchObject({ code: '42501' });
    await asUser(database, viewer); await expect(database.query('select public.report_release($1,$2)', [official, 'short'])).rejects.toMatchObject({ code: '23514' });
    const result = await database.query<{ id: string }>('select public.report_release($1,$2) as id', [official, 'A specific report in an isolated database']); const reportId = result.rows[0]!.id;
    expect((await database.query<{ reporter_id: string }>('select reporter_id from public.release_reports where id=$1', [reportId])).rows).toEqual([{ reporter_id: viewer }]);
    await asUser(database, other); expect((await database.query('select id from public.release_reports where id=$1', [reportId])).rows).toHaveLength(0);
    await expect(database.query('insert into public.release_reports(release_id,reporter_id,reason) values($1,$2,$3)', [official, viewer, 'Impersonation must be denied'])).rejects.toMatchObject({ code: '42501' });
  });

  it('removes suspended/revoked rows from fresh public queries and refuses new reports', async () => {
    await database.exec('reset role; set role service_role'); await database.query('update public.public_releases set status=\'revoked\' where id=$1', [official]); await database.query('update public.public_releases set status=\'suspended\' where id=$1', [material]);
    await database.exec('reset role; set role anon'); expect((await search('project', true)).rows).toHaveLength(0); expect((await search('resource', false, 'Community')).rows).toHaveLength(0);
    // Owners may inspect status through staff RLS; the discovery RPC still explicitly excludes their hidden releases.
    await asUser(database, owner); expect((await search('project', true)).rows).toHaveLength(0); await expect(database.query('select public.report_release($1,$2)', [official, 'No longer publicly available'])).rejects.toThrow('RELEASE_NOT_FOUND');
  });
});
