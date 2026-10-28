import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createBasicWorkflow } from '@studio/spec';
import { canonicalDigest } from '@studio/package-kit';
import { asUser, createPolicyDatabase } from './postgres-harness';
import { deliveryArtifact } from '../helpers/publication-delivery';
import { copyRightsEvidenceBytes, verifyCopyRightsEvidence, type CopyRightsEvidence, type CopyRightsTrust } from '../../apps/studio-web/src/jobs/publication-scan/copy-rights';
import { recordReviewedCopyRights, type CopyRightsRepository } from '../../apps/studio-web/src/jobs/publication-scan/copy-rights-pipeline';

/** Actual SQL policies and real ephemeral signatures; Storage/Auth and operator identity are test boundaries only. */
describe('private copy permission database', () => {
  const owner = '10000000-0000-4000-8000-000000000001', reviewer = '20000000-0000-4000-8000-000000000002'; let db: PGlite; let serial = 0;
  const service = () => db.exec('reset role; set role service_role');
  beforeAll(async () => {
    db = await createPolicyDatabase([owner, reviewer]);
    for (const name of ['002-publications.sql', '003-public-release-metadata.sql', '004-public-release-search.sql', '005-publication-candidates.sql', '006-review-readiness.sql', '007-release-lifecycle.sql', '008-publication-delivery.sql', '009-publication-copy-rights.sql']) await db.exec(await readFile(new URL(`../../infrastructure/supabase/migrations/${name}`, import.meta.url), 'utf8'));
    await db.query("insert into public.studio_roles values($1,'reviewer'),($1,'moderator')", [reviewer]);
  }, 30000);
  afterAll(async () => { await db?.close(); });
  async function fixture() {
    const sequence = ++serial; await asUser(db, owner); const workflow = createBasicWorkflow(`독립 복사 권리 ${sequence}`);
    const project = (await db.query<{ result: { project: { id: string } } }>('select public.create_private_project($1,$2,$3) as result', [workflow.name, workflow, {}])).rows[0]!.result.project.id;
    const revision = (await db.query<{ result: { id: string } }>('select public.snapshot_private_project($1,1,$2) as result', [project, canonicalDigest(workflow)])).rows[0]!.result.id;
    const submission = (await db.query<{ id: string }>("select public.submit_publication('project',$1) as id", [revision])).rows[0]!.id;
    const snapshot = (await db.query<{ source_snapshot: unknown }>('select source_snapshot from public.publication_submissions where id=$1', [submission])).rows[0]!.source_snapshot;
    const artifact = await deliveryArtifact({ workflow, snapshot, keyId: `copy-package-${sequence}` }); expect(artifact.report.status).toBe('passed'); await service();
    await db.query("insert into public.publication_rights_authorities(key_id,public_key_sha256) values('rights-test',$1) on conflict(key_id) do update set public_key_sha256=$1,revoked_at=null", [artifact.rightsHash]);
    await db.query('select public.register_publication_candidate($1,$2,$3,$4)', [submission, artifact.report.artifactSha256, artifact.report.sourceSnapshotSha256, artifact.bytes.length]);
    await db.query('select public.record_publication_scan($1,$2,$3,true,true,true,true,$4)', [submission, artifact.report.artifactSha256, artifact.report.manifestSha256, artifact.report]);
    await asUser(db, reviewer); await db.query("select public.review_publication($1,$2,'approved','원본 파일의 배포 검수를 확인했습니다')", [submission, artifact.report.artifactSha256]); await service();
    const release = (await db.query<{ id: string }>('select public.publish_reviewed_release($1,$2,$3,$4,$5,false) as id', [submission, artifact.report.artifactSha256, workflow.name, '독립 복사 경계 시험', `releases/${submission}/${artifact.report.artifactSha256}.zip`])).rows[0]!.id;
    await db.query('insert into public.publication_signing_keys(key_id,public_key_pem,public_key_sha256,not_before,expires_at) values($1,$2,$3,$4,$5)', [artifact.keyId, artifact.publicKey, artifact.keyHash, '2020-01-01T00:00:00Z', '2036-01-01T00:00:00Z']);
    await db.query('select public.register_publication_delivery($1,$2,$3,$4,$5,$6,$7)', [release, artifact.report.artifactSha256, artifact.report.manifestSha256, artifact.bytes.length, artifact.keyId, artifact.keyHash, artifact.host]);
    const pair = generateKeyPairSync('ed25519'), keyId = `copy-authority-${sequence}`;
    const authority: CopyRightsTrust = { purpose: 'private-authoring-copy', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), publicKeySha256: createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'), notBefore: '2020-01-01T00:00:00Z', expiresAt: '2036-01-01T00:00:00Z', revoked: false };
    await db.query('insert into public.publication_copy_authorities(key_id,public_key_pem,public_key_sha256,not_before,expires_at) values($1,$2,$3,$4,$5)', [keyId, authority.publicKey, authority.publicKeySha256, authority.notBefore, authority.expiresAt]);
    const body: Omit<CopyRightsEvidence, 'signature'> = { schemaVersion: '1.0.0', artifactSha256: artifact.report.artifactSha256, sourceSnapshotSha256: artifact.report.sourceSnapshotSha256, scope: 'whole-package', privateCopy: true, modification: true, reviewerId: 'copy-reviewer-test', evidenceSha256: 'e'.repeat(64), reviewedAt: '2021-01-01T00:00:00Z', expiresAt: '2035-01-01T00:00:00Z' };
    const signed = (changes: Partial<typeof body> = {}): CopyRightsEvidence => { const content = { ...body, ...changes }; return { ...content, signature: { keyId, value: sign(null, copyRightsEvidenceBytes(content), pair.privateKey).toString('base64url') } }; };
    const evidence = signed(); expect(verifyCopyRightsEvidence(evidence, body.artifactSha256, body.sourceSnapshotSha256, { [keyId]: authority }, new Date())).toEqual(evidence);
    const register = (value: unknown = evidence, digest = canonicalDigest(value)) => db.query('select public.register_publication_copy_rights($1,$2,$3)', [release, value, digest]);
    const resolve = () => db.query<{ value: { delivery: { artifactSha256: string; sourceSnapshotSha256: string }; copyRights: { evidence: CopyRightsEvidence; evidenceSha256: string; authority: CopyRightsTrust } } }>('select public.resolve_publication_copy($1) as value', [release]);
    return { release, artifact, keyId, evidence, body, signed, register, resolve, authority };
  }
  it('does not derive edit/copy rights from a published, downloadable release', async () => {
    const item = await fixture(); await expect(db.query('select public.resolve_publication_delivery($1)', [item.release])).resolves.toBeDefined(); await expect(item.resolve()).rejects.toThrow('COPY_RIGHTS_UNAVAILABLE');
  });
  it('returns a current grant only to service and keeps UTC trust compatible with the crypto verifier', async () => {
    const item = await fixture(); await item.register(); await item.register(); const result = (await item.resolve()).rows[0]!.value;
    expect(result.copyRights.evidenceSha256).toBe(canonicalDigest(item.evidence)); expect(result.copyRights.evidence).toEqual(item.evidence);
    expect(verifyCopyRightsEvidence(result.copyRights.evidence, result.delivery.artifactSha256, result.delivery.sourceSnapshotSha256, { [item.keyId]: result.copyRights.authority }, new Date())).toEqual(item.evidence);
    expect((await db.query<{ count: number }>('select count(*)::integer as count from public.publication_copy_rights where release_id=$1', [item.release])).rows[0]!.count).toBe(1);
    expect((await db.query<{ count: number }>("select count(*)::integer as count from public.publication_audit where release_id=$1 and action='copy_rights_registered'", [item.release])).rows[0]!.count).toBe(1);
  });
  it('denies owners, reviewers and anonymous callers direct rights, keys and RPC access', async () => {
    const item = await fixture(); await item.register();
    for (const identity of [owner, reviewer]) { await asUser(db, identity); for (const table of ['publication_copy_authorities', 'publication_copy_rights']) await expect(db.query(`select * from public.${table}`)).rejects.toMatchObject({ code: '42501' }); await expect(item.resolve()).rejects.toMatchObject({ code: '42501' }); await expect(item.register()).rejects.toMatchObject({ code: '42501' }); }
    await db.exec('reset role; set role anon'); await expect(item.resolve()).rejects.toMatchObject({ code: '42501' }); await expect(item.register()).rejects.toMatchObject({ code: '42501' });
  });
  it('requires exact whole-package booleans, source and closed evidence fields', async () => {
    const item = await fixture();
    for (const patch of [{ privateCopy: false }, { modification: 'true' }, { scope: 'workflow-only' }, { artifactSha256: 'f'.repeat(64) }, { sourceSnapshotSha256: 'f'.repeat(64) }, { other: true }, { signature: [] }]) await expect(item.register({ ...item.evidence, ...patch })).rejects.toThrow('COPY_RIGHTS_INVALID');
    await expect(item.register([])).rejects.toThrow('COPY_RIGHTS_INVALID'); await expect(item.register(item.artifact.report.rightsEvidence)).rejects.toThrow('COPY_RIGHTS_INVALID');
  });
  it('rejects out-of-authority, expired and future signed grants', async () => {
    const item = await fixture(); for (const patch of [{ reviewedAt: '2019-01-01T00:00:00Z' }, { reviewedAt: '2030-01-01T00:00:00Z' }, { expiresAt: '2020-01-01T00:00:00Z' }, { expiresAt: '2037-01-01T00:00:00Z' }]) await expect(item.register(item.signed(patch))).rejects.toThrow('COPY_RIGHTS_UNAVAILABLE');
  });
  it('rejects changed evidence on the same hash and preserves the original grant', async () => {
    const item = await fixture(); await item.register(); await expect(item.register(item.signed({ reviewerId: 'different-review' }), canonicalDigest(item.evidence))).rejects.toThrow('COPY_RIGHTS_RETRY_CONFLICT'); expect((await item.resolve()).rows[0]!.value.copyRights.evidence).toEqual(item.evidence);
  });
  it('checks elapsed wall time even when the transaction started before grant expiration', async () => {
    const item = await fixture(); await db.exec('begin');
    try {
      const expiring = item.signed({ expiresAt: new Date(Date.now() + 1000).toISOString() });
      await item.register(expiring); await delay(1100);
      await expect(item.resolve()).rejects.toThrow('COPY_RIGHTS_UNAVAILABLE');
    } finally { await db.exec('rollback'); }
    await db.exec('begin');
    try {
      const expiring = item.signed({ expiresAt: new Date(Date.now() + 1000).toISOString() }); await delay(1100);
      await expect(item.register(expiring)).rejects.toThrow('COPY_RIGHTS_UNAVAILABLE');
    } finally { await db.exec('rollback'); }
  });
  it('checks grant and authority revocation without allowing later resurrection', async () => {
    const item = await fixture(); await item.register(); await db.query('update public.publication_copy_rights set revoked_at=now() where evidence_sha256=$1', [canonicalDigest(item.evidence)]); await expect(item.resolve()).rejects.toThrow('COPY_RIGHTS_UNAVAILABLE'); await expect(db.query('update public.publication_copy_rights set revoked_at=null where evidence_sha256=$1', [canonicalDigest(item.evidence)])).rejects.toThrow('COPY_RIGHTS_IMMUTABLE');
    const next = await fixture(); await next.register(); await db.query('update public.publication_copy_authorities set revoked_at=now() where key_id=$1', [next.keyId]); await expect(next.resolve()).rejects.toThrow('COPY_RIGHTS_UNAVAILABLE'); await expect(db.query('update public.publication_copy_authorities set revoked_at=null where key_id=$1', [next.keyId])).rejects.toThrow('COPY_AUTHORITY_IMMUTABLE');
  });
  it('rechecks distribution moderation and signing trust even while copy rights remain valid', async () => {
    const item = await fixture(); await item.register(); await asUser(db, reviewer); await db.query("select public.moderate_release($1,'suspended','배포 권한을 다시 확인하기 위해 중단합니다')", [item.release]); await service(); await expect(item.resolve()).rejects.toThrow('DELIVERY_NOT_AVAILABLE');
    const next = await fixture(); await next.register(); await db.query('update public.publication_signing_keys set revoked_at=now() where key_id=$1', [next.artifact.keyId]); await expect(next.resolve()).rejects.toThrow('DELIVERY_NOT_AVAILABLE');
  });
  it('prevents in-place authority rotation or content rewrite with the routine service role', async () => {
    const item = await fixture(); await item.register(); await expect(db.query('update public.publication_copy_authorities set public_key_sha256=$2 where key_id=$1', [item.keyId, 'f'.repeat(64)])).rejects.toThrow('COPY_AUTHORITY_IMMUTABLE');
    await expect(db.query("update public.publication_copy_rights set evidence='{}'::jsonb where release_id=$1", [item.release])).rejects.toMatchObject({ code: '42501' });
    await expect(db.query('delete from public.publication_copy_rights where release_id=$1', [item.release])).rejects.toMatchObject({ code: '42501' });
  });
  it('records only evidence that the actual worker verifier accepts and preserves bytes across lookup awaits', async () => {
    const item = await fixture(); let writes = 0;
    const repository: CopyRightsRepository = {
      async source() { return { artifactSha256: item.body.artifactSha256, sourceSnapshotSha256: item.body.sourceSnapshotSha256 }; },
      async authority() { return item.authority; },
      async record(id, evidence, sha) { expect(id).toBe(item.release); writes++; await item.register(evidence, sha); },
    };
    await expect(recordReviewedCopyRights(repository, item.release, { ...item.evidence, signature: { ...item.evidence.signature, value: 'a'.repeat(86) } })).rejects.toThrow('COPY_RIGHTS_UNAVAILABLE'); expect(writes).toBe(0);
    const input = structuredClone(item.evidence); const recording = recordReviewedCopyRights(repository, item.release, input); input.privateCopy = false as true; input.signature.value = 'b'.repeat(86);
    expect(await recording).toEqual({ evidenceSha256: canonicalDigest(item.evidence) }); expect(writes).toBe(1); expect((await item.resolve()).rows[0]!.value.copyRights.evidence).toEqual(item.evidence);
  });
  it('lets the final SQL transaction refuse authority revocation after worker verification without retry', async () => {
    const item = await fixture(); let attempts = 0;
    await expect(recordReviewedCopyRights({
      async source() { return { artifactSha256: item.body.artifactSha256, sourceSnapshotSha256: item.body.sourceSnapshotSha256 }; },
      async authority() { return item.authority; },
      async record(_id, evidence, sha) { attempts++; await db.query('update public.publication_copy_authorities set revoked_at=now() where key_id=$1', [item.keyId]); await item.register(evidence, sha); },
    }, item.release, item.evidence)).rejects.toThrow('COPY_RIGHTS_UNAVAILABLE'); expect(attempts).toBe(1);
  });
});
