import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { PGlite } from '@electric-sql/pglite';
import { createBasicWorkflow } from '@studio/spec';
import { canonicalDigest } from '@studio/package-kit';
import { asUser, createPolicyDatabase } from './postgres-harness';
import { deliveryArtifact } from '../helpers/publication-delivery';

/** The real migrations run in PostgreSQL; only Auth injection and external Storage object metadata are fixtures. */
describe('private publication delivery SQL boundary', () => {
  const owner = '10000000-0000-4000-8000-000000000001', reviewer = '20000000-0000-4000-8000-000000000002'; let db: PGlite; let sequence = 0;
  const service = () => db.exec('reset role; set role service_role');
  async function published(options: { expiresIn?: number; path?: string } = {}) {
    await asUser(db, owner); const workflow = createBasicWorkflow('고정 공개 ZIP 전달');
    const project = (await db.query<{ result: { project: { id: string } } }>('select public.create_private_project($1,$2,$3) as result', [workflow.name, workflow, {}])).rows[0]!.result.project.id;
    const revision = (await db.query<{ result: { id: string } }>('select public.snapshot_private_project($1,1,$2) as result', [project, canonicalDigest(workflow)])).rows[0]!.result.id;
    const submission = (await db.query<{ id: string }>("select public.submit_publication('project',$1) as id", [revision])).rows[0]!.id;
    const snapshot = (await db.query<{ source_snapshot: unknown }>('select source_snapshot from public.publication_submissions where id=$1', [submission])).rows[0]!.source_snapshot;
    const artifact = await deliveryArtifact({ workflow, snapshot, keyId: `package-${++sequence}` }); expect(artifact.report.status).toBe('passed');
    await service(); await db.query("insert into public.publication_rights_authorities(key_id,public_key_sha256) values('rights-test',$1) on conflict(key_id) do update set public_key_sha256=$1,revoked_at=null", [artifact.rightsHash]);
    await db.query('select public.register_publication_candidate($1,$2,$3,$4)', [submission, artifact.report.artifactSha256, artifact.report.sourceSnapshotSha256, artifact.bytes.length]);
    await db.query('select public.record_publication_scan($1,$2,$3,true,true,true,true,$4)', [submission, artifact.report.artifactSha256, artifact.report.manifestSha256, artifact.report]);
    await asUser(db, reviewer); await db.query("select public.review_publication($1,$2,'approved','고정된 최종 서명 파일과 현재 권리 근거를 확인했습니다')", [submission, artifact.report.artifactSha256]);
    await service(); const storagePath = options.path ?? `releases/${submission}/${artifact.report.artifactSha256}.zip`;
    const release = (await db.query<{ id: string }>('select public.publish_reviewed_release($1,$2,$3,$4,$5,false) as id', [submission, artifact.report.artifactSha256, '공개 ZIP', '검증된 원본 바이트', storagePath])).rows[0]!.id;
    const expiry = options.expiresIn === undefined ? '2036-01-01T00:00:00.000Z' : new Date(Date.now() + options.expiresIn).toISOString();
    await db.query('insert into public.publication_signing_keys(key_id,public_key_pem,public_key_sha256,not_before,expires_at) values($1,$2,$3,$4,$5)', [artifact.keyId, artifact.publicKey, artifact.keyHash, '2020-01-01T00:00:00Z', expiry]);
    return { ...artifact, submission, release, storagePath };
  }
  const register = (item: Awaited<ReturnType<typeof published>>, overrides: unknown[] = []) => db.query('select public.register_publication_delivery($1,$2,$3,$4,$5,$6,$7)', overrides.length ? overrides : [item.release, item.report.artifactSha256, item.report.manifestSha256, item.bytes.length, item.keyId, item.keyHash, item.host]);
  const resolve = (id: string) => db.query<{ value: Record<string, unknown> }>('select public.resolve_publication_delivery($1) as value', [id]);
  beforeAll(async () => {
    db = await createPolicyDatabase([owner, reviewer]);
    for (const name of ['002-publications.sql', '003-public-release-metadata.sql', '004-public-release-search.sql', '005-publication-candidates.sql', '006-review-readiness.sql', '007-release-lifecycle.sql', '008-publication-delivery.sql']) await db.exec(await readFile(new URL(`../../infrastructure/supabase/migrations/${name}`, import.meta.url), 'utf8'));
    await db.query("insert into public.studio_roles values($1,'reviewer'),($1,'moderator')", [reviewer]);
  }, 30000);
  afterAll(async () => { await db?.close(); });

  it('denies users, reviewers and anonymous callers any key, path or service operation', async () => {
    const item = await published(); await register(item);
    for (const role of ['anon', 'authenticated']) { await db.exec(`reset role; set role ${role}`); for (const table of ['publication_signing_keys', 'publication_delivery_artifacts']) await expect(db.query(`select * from public.${table}`)).rejects.toMatchObject({ code: '42501' }); await expect(resolve(item.release)).rejects.toMatchObject({ code: '42501' }); await expect(register(item)).rejects.toMatchObject({ code: '42501' }); }
    await asUser(db, reviewer); await expect(resolve(item.release)).rejects.toMatchObject({ code: '42501' }); await expect(db.query('select storage_path from public.public_releases')).rejects.toMatchObject({ code: '42501' });
  });
  it('keeps the release bucket private and invisible to direct authenticated object reads', async () => {
    await db.exec('reset role'); expect((await db.query<{ public: boolean }>("select public from storage.buckets where id='publication-releases'")).rows[0]!.public).toBe(false);
    await db.query("insert into storage.objects(bucket_id,name) values('publication-releases','releases/hidden/private.zip')"); await asUser(db, owner); expect((await db.query("select * from storage.objects where bucket_id='publication-releases'")).rows).toEqual([]); await expect(db.query("insert into storage.objects(bucket_id,name) values('publication-releases','releases/injected.zip')")).rejects.toMatchObject({ code: '42501' });
  });
  it('pins one delivery on retries and exposes its exact metadata only to the service', async () => {
    const item = await published(); await register(item); await register(item); const value = (await resolve(item.release)).rows[0]!.value;
    expect(value).toMatchObject({ releaseId: item.release, artifactSha256: item.report.artifactSha256, manifestSha256: item.report.manifestSha256, artifactBytes: item.bytes.length, targetHost: 'codex', storagePath: item.storagePath, signingKey: { id: item.keyId, sha256: item.keyHash } }); expect(value).not.toHaveProperty('owner_id'); expect(value).not.toHaveProperty('source_snapshot');
    expect((await db.query("select id from public.publication_audit where release_id=$1 and action='delivery_registered'", [item.release])).rows).toHaveLength(1);
    await expect(register(item, [item.release, item.report.artifactSha256, item.report.manifestSha256, item.bytes.length, item.keyId, item.keyHash, 'opencode'])).rejects.toThrow('DELIVERY_RETRY_CONFLICT');
    await expect(db.query('update public.publication_delivery_artifacts set artifact_bytes=1 where release_id=$1', [item.release])).rejects.toMatchObject({ code: '42501' });
  });
  it('rejects wrong bytes, manifest, key fingerprint and legacy arbitrary delivery paths', async () => {
    const item = await published(); const args = [item.release, item.report.artifactSha256, item.report.manifestSha256, item.bytes.length, item.keyId, item.keyHash, item.host];
    for (const [position, value] of [[1, 'a'.repeat(64)], [2, 'b'.repeat(64)], [3, item.bytes.length + 1], [5, 'c'.repeat(64)]] as const) { const bad = [...args]; bad[position] = value; await expect(register(item, bad)).rejects.toThrow(/DELIVERY_(ARTIFACT_MISMATCH|SIGNING_KEY_INVALID)/); }
    const legacy = await published({ path: 'releases/legacy/codex.zip' }); await expect(register(legacy)).rejects.toThrow('DELIVERY_ARTIFACT_MISMATCH'); await expect(resolve(legacy.release)).rejects.toThrow('DELIVERY_NOT_AVAILABLE');
  });
  it('blocks signing-key revocation immediately and prevents clearing or substituting the key', async () => {
    const item = await published(); await register(item); await db.query('update public.publication_signing_keys set revoked_at=now() where key_id=$1', [item.keyId]); await expect(resolve(item.release)).rejects.toThrow('DELIVERY_NOT_AVAILABLE'); await expect(register(item)).rejects.toThrow('DELIVERY_SIGNING_KEY_INVALID');
    await expect(db.query('update public.publication_signing_keys set revoked_at=null where key_id=$1', [item.keyId])).rejects.toThrow('SIGNING_KEY_IMMUTABLE');
    await expect(db.query('update public.publication_signing_keys set public_key_sha256=$2 where key_id=$1', [item.keyId, 'f'.repeat(64)])).rejects.toThrow('SIGNING_KEY_IMMUTABLE');
  });
  it('rechecks key expiry on lookup after an initially valid delivery was registered', async () => {
    const item = await published({ expiresIn: 2000 }); await register(item); expect((await resolve(item.release)).rows).toHaveLength(1); await new Promise((done) => setTimeout(done, 2100)); await expect(resolve(item.release)).rejects.toThrow('DELIVERY_NOT_AVAILABLE');
  });
  it('rejects already expired or not-yet-valid operator keys', async () => {
    const expired = await published({ expiresIn: -1000 }); await expect(register(expired)).rejects.toThrow('DELIVERY_SIGNING_KEY_INVALID');
    const item = await published(); await db.query('insert into public.publication_signing_keys(key_id,public_key_pem,public_key_sha256,not_before,expires_at) values($1,$2,$3,$4,$5)', ['future-key', item.publicKey, item.keyHash, '2090-01-01T00:00:00Z', '2091-01-01T00:00:00Z']); await expect(register(item, [item.release, item.report.artifactSha256, item.report.manifestSha256, item.bytes.length, 'future-key', item.keyHash, item.host])).rejects.toThrow('DELIVERY_SIGNING_KEY_INVALID');
  });
  it('rechecks current rights and moderation instead of relying on the original approval', async () => {
    const item = await published(); await register(item); await db.query("update public.publication_rights_authorities set revoked_at=now() where key_id='rights-test'"); await expect(resolve(item.release)).rejects.toThrow('DELIVERY_NOT_AVAILABLE');
    const current = await published(); await register(current); await asUser(db, reviewer); await db.query("select public.moderate_release($1,'suspended','현재 신고 내용을 검토하기 위해 중단합니다')", [current.release]); await service(); await expect(resolve(current.release)).rejects.toThrow('DELIVERY_NOT_AVAILABLE');
    await asUser(db, reviewer); await db.query("select public.moderate_release($1,'revoked','현재 공개 파일의 사용 권한을 철회합니다')", [current.release]); await service(); await expect(resolve(current.release)).rejects.toThrow('DELIVERY_NOT_AVAILABLE');
  });
  it('refuses corrupted persisted size and stale scan identity even with a delivery row', async () => {
    const item = await published(); await register(item); await db.exec('reset role'); await db.query('update public.publication_delivery_artifacts set artifact_bytes=artifact_bytes+1 where release_id=$1', [item.release]); await service(); await expect(resolve(item.release)).rejects.toThrow('DELIVERY_NOT_AVAILABLE');
    const current = await published(); await register(current); await db.query("update public.publication_scans set evidence=jsonb_set(evidence,'{sourceSnapshotSha256}',to_jsonb($2::text)) where submission_id=$1", [current.submission, 'a'.repeat(64)]); await expect(resolve(current.release)).rejects.toThrow('DELIVERY_NOT_AVAILABLE');
  });
});
