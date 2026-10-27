import { readFile } from 'node:fs/promises';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createPolicyDatabase } from './postgres-harness.js';

/** These tests prove database authorization and hash binding, not a real malware scan, human review, or publication. */
describe('publication authorization and immutable lifecycle', () => {
  const owner = '10000000-0000-4000-8000-000000000001';
  const reviewer = '20000000-0000-4000-8000-000000000002';
  const stranger = '30000000-0000-4000-8000-000000000003';
  let database: PGlite;
  let projectId: string; let versionId: string;
  beforeAll(async () => {
    database = await createPolicyDatabase([owner, reviewer, stranger]);
    await database.exec(await readFile(new URL('../../infrastructure/supabase/migrations/002-publications.sql', import.meta.url), 'utf8'));
    await database.query("insert into public.studio_roles values($1,'reviewer'),($1,'moderator')", [reviewer]);
    await asUser(database, owner);
    const project = await database.query<{ result: { project: { id: string } } }>("select public.create_private_project('Private source','{\"marker\":\"submitted content\"}'::jsonb,'{}'::jsonb) as result");
    projectId = project.rows[0]!.result.project.id;
    const version = await database.query<{ result: { id: string } }>('select public.snapshot_private_project($1,1,$2) as result', [projectId, 'a'.repeat(64)]);
    versionId = version.rows[0]!.result.id;
  }, 30000);
  afterAll(async () => { await database?.close(); });

  it('prevents foreign submission, role escalation and client-side scan attestations', async () => {
    await asUser(database, stranger);
    await expect(database.query("select public.submit_publication('project',$1)", [versionId])).rejects.toMatchObject({ code: '42501' });
    await expect(database.query("insert into public.studio_roles values($1,'administrator')", [stranger])).rejects.toMatchObject({ code: '42501' });
    await expect(database.query("select public.record_publication_scan($1,$2,$2,true,true,true,true,'{}'::jsonb)", [versionId, 'a'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
  });
  it('binds scan, review and release to one artifact and keeps unpublished versions private', async () => {
    await asUser(database, owner);
    const submitted = await database.query<{ id: string }>("select public.submit_publication('project',$1) as id", [versionId]);
    const submission = submitted.rows[0]!.id;
    await expect(database.query('select public.review_publication($1,$2,$3,$4)', [submission, 'b'.repeat(64), 'approved', 'Owner cannot approve without a role'])).rejects.toMatchObject({ code: '42501' });
    await asUser(database, stranger);
    expect((await database.query('select * from public.publication_submissions')).rows).toHaveLength(0);
    await asUser(database, reviewer);
    expect((await database.query('select * from public.projects')).rows).toHaveLength(0);
    expect((await database.query('select * from public.publication_submissions')).rows).toHaveLength(1);
    await expect(database.query('select public.review_publication($1,$2,$3,$4)', [submission, 'b'.repeat(64), 'approved', 'No scan yet'])).rejects.toThrow('INVALID_PUBLICATION_STATE');

    // Privileged scan results are fixture attestations here; no external scan success is recorded outside this test DB.
    await database.exec('reset role; set role service_role');
    await database.query("select public.record_publication_scan($1,$2,$3,true,true,true,true,$4::jsonb)", [submission, 'b'.repeat(64), 'c'.repeat(64), '{"testBoundary":"scanner attestation"}']);
    await asUser(database, reviewer);
    await expect(database.query('select public.review_publication($1,$2,$3,$4)', [submission, 'd'.repeat(64), 'approved', 'Wrong bytes'])).rejects.toThrow('REVIEW_HASH_MISMATCH');
    await database.query('select public.review_publication($1,$2,$3,$4)', [submission, 'b'.repeat(64), 'approved', 'Reviewed exact fixture artifact']);
    await expect(database.query('select public.publish_reviewed_release($1,$2,$3,$4,$5,false)', [submission, 'b'.repeat(64), 'Policy fixture', '', 'releases/policy/codex.zip'])).rejects.toMatchObject({ code: '42501' });
    await database.exec('reset role; set role service_role');
    await expect(database.query('select public.publish_reviewed_release($1,$2,$3,$4,$5,false)', [submission, 'd'.repeat(64), 'Policy fixture', '', 'releases/policy/codex.zip'])).rejects.toThrow('RELEASE_HASH_MISMATCH');
    await expect(database.query('select public.publish_reviewed_release($1,$2,$3,$4,$5,true)', [submission, 'b'.repeat(64), 'Policy fixture', '', 'releases/policy/codex.zip'])).rejects.toThrow('OFFICIAL_ADMIN_REQUIRED');
    const published = await database.query<{ id: string }>('select public.publish_reviewed_release($1,$2,$3,$4,$5,false) as id', [submission, 'b'.repeat(64), 'Policy fixture', '', 'releases/policy/codex.zip']);
    const release = published.rows[0]!.id;

    await database.exec('reset role; set role anon');
    expect((await database.query('select * from public.public_releases')).rows).toHaveLength(1);
    await expect(database.query('select * from public.publication_scans')).rejects.toMatchObject({ code: '42501' });
    await asUser(database, stranger);
    await database.query('select public.report_release($1,$2)', [release, 'Investigate a specific issue in this test artifact']);
    expect((await database.query('select * from public.public_releases')).rows).toHaveLength(1);
    await expect(database.query('select public.moderate_release($1,$2,$3)', [release, 'revoked', 'Stranger cannot revoke releases'])).rejects.toMatchObject({ code: '42501' });
    await asUser(database, reviewer);
    await database.query('select public.moderate_release($1,$2,$3)', [release, 'revoked', 'Confirmed policy fixture issue requiring revocation']);
    await expect(database.query('select public.moderate_release($1,$2,$3)', [release, 'published', 'Attempt to skip a new review'])).rejects.toThrow('REVOKED_RELEASE_NEEDS_NEW_REVIEW');
    await database.exec('reset role; set role anon');
    expect((await database.query('select * from public.public_releases')).rows).toHaveLength(0);

    await asUser(database, owner);
    await database.query('delete from public.projects where id=$1', [projectId]);
    const snapshot = await database.query<{ source_snapshot: { workflow: { marker: string } } }>('select source_snapshot from public.publication_submissions where id=$1', [submission]);
    expect(snapshot.rows[0]!.source_snapshot.workflow.marker).toBe('submitted content');
  });
  it('requires every scan check and refuses replacing an already-scanned artifact', async () => {
    await asUser(database, owner);
    const resource = await database.query<{ result: { version: { id: string } } }>("select public.create_private_resource('License review','document','','{}'::jsonb,$1) as result", ['e'.repeat(64)]);
    const submitted = await database.query<{ id: string }>("select public.submit_publication('resource',$1) as id", [resource.rows[0]!.result.version.id]);
    const submission = submitted.rows[0]!.id;
    await database.exec('reset role; set role service_role');
    await database.query("select public.record_publication_scan($1,$2,$2,true,false,true,true,'{}'::jsonb)", [submission, 'f'.repeat(64)]);
    await expect(database.query("select public.record_publication_scan($1,$2,$2,true,true,true,true,'{}'::jsonb)", [submission, 'f'.repeat(64)])).rejects.toThrow('INVALID_PUBLICATION_STATE');
    await asUser(database, reviewer);
    await expect(database.query('select public.review_publication($1,$2,$3,$4)', [submission, 'f'.repeat(64), 'approved', 'Cannot override missing redistribution rights'])).rejects.toThrow('INVALID_PUBLICATION_STATE');
    const row = await database.query<{ status: string }>('select status from public.publication_submissions where id=$1', [submission]);
    expect(row.rows[0]!.status).toBe('changes_requested');
  });
});
