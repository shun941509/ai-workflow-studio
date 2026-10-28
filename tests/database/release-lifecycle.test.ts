import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createBasicWorkflow } from '@studio/spec';
import { buildPackage, canonicalDigest } from '@studio/package-kit';
import { collectRequirements } from '@studio/workflow-core';
import { asUser, createPolicyDatabase } from './postgres-harness';
import { scanPublication, digestBytes } from '../../apps/studio-web/src/jobs/publication-scan/scanner';
import { rightsEvidenceBytes, rightsKeyFingerprint, type RightsEvidence } from '../../apps/studio-web/src/jobs/publication-scan/rights';

/** Ephemeral test keys exercise the real scanner and PostgreSQL gates; they never become an operator trust registry. */
describe('current publication evidence at release and restoration', () => {
  const owner = '10000000-0000-4000-8000-000000000001', reviewer = '20000000-0000-4000-8000-000000000002';
  const keys = generateKeyPairSync('ed25519');
  const trust = { rights: { purpose: 'redistribution-rights' as const, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } };
  let database: PGlite;
  const service = () => database.exec('reset role; set role service_role');
  async function approved() {
    await service(); await database.query("update public.publication_rights_authorities set revoked_at=null,public_key_sha256=$1 where key_id='rights'", [rightsKeyFingerprint(trust.rights)]);
    await asUser(database, owner); const workflow = createBasicWorkflow('공개 시점 권리 확인');
    const project = await database.query<{ data: { project: { id: string } } }>('select public.create_private_project($1,$2,$3) as data', [workflow.name, workflow, {}]);
    const revision = await database.query<{ data: { id: string } }>('select public.snapshot_private_project($1,1,$2) as data', [project.rows[0]!.data.project.id, canonicalDigest(workflow)]);
    const submitted = await database.query<{ id: string }>("select public.submit_publication('project',$1) as id", [revision.rows[0]!.data.id]); const id = submitted.rows[0]!.id;
    const snapshot = (await database.query<{ source_snapshot: unknown }>('select source_snapshot from public.publication_submissions where id=$1', [id])).rows[0]!.source_snapshot;
    const bytes = (await buildPackage({ workflow, host: 'codex' })).bytes;
    const body: Omit<RightsEvidence, 'signature'> = { schemaVersion: '1.0.0', artifactSha256: digestBytes(bytes), sourceSnapshotSha256: canonicalDigest(snapshot), scope: 'whole-package', redistribution: true, reviewerId: 'test-rights-reviewer', evidenceSha256: 'e'.repeat(64), reviewedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2036-01-01T00:00:00.000Z' };
    const report = await scanPublication({ bytes, source: { kind: 'project', snapshot }, policy: { id: 'test-static', version: '1.0.0', supportedCapabilities: collectRequirements(workflow).capabilities }, rightsTrust: trust, rightsEvidence: { ...body, signature: { keyId: 'rights', value: sign(null, rightsEvidenceBytes(body), keys.privateKey).toString('base64url') } } });
    expect(report.status).toBe('passed'); await service();
    await database.query('select public.register_publication_candidate($1,$2,$3,$4)', [id, report.artifactSha256, report.sourceSnapshotSha256, bytes.length]);
    await database.query('select public.record_publication_scan($1,$2,$3,true,true,true,true,$4)', [id, report.artifactSha256, report.manifestSha256, report]);
    await asUser(database, reviewer); await database.query("select public.review_publication($1,$2,'approved','현재 권리와 고정 원본 보고서를 검토했습니다')", [id, report.artifactSha256]);
    await service(); return { id, report };
  }
  async function publish(item: Awaited<ReturnType<typeof approved>>, title = '공개 검증 프로젝트', official = false) {
    return database.query<{ id: string }>('select public.publish_reviewed_release($1,$2,$3,$4,$5,$6) as id', [item.id, item.report.artifactSha256, title, '검증용 실제 불변 패키지', `releases/${item.id}/codex.zip`, official]);
  }
  beforeAll(async () => {
    database = await createPolicyDatabase([owner, reviewer]);
    for (const name of ['002-publications.sql', '003-public-release-metadata.sql', '004-public-release-search.sql', '005-publication-candidates.sql', '006-review-readiness.sql', '007-release-lifecycle.sql']) await database.exec(await readFile(new URL(`../../infrastructure/supabase/migrations/${name}`, import.meta.url), 'utf8'));
    await database.query("insert into public.studio_roles values($1,'reviewer'),($1,'moderator')", [reviewer]);
    await database.query("insert into public.publication_rights_authorities(key_id,public_key_sha256) values('rights',$1)", [rightsKeyFingerprint(trust.rights)]);
  }, 30000);
  afterAll(async () => { await database?.close(); });

  it('keeps the current-evidence lookup and publication outside browser privileges', async () => {
    const item = await approved();
    for (const role of ['anon', 'authenticated']) {
      await database.exec(`reset role; set role ${role}`);
      await expect(database.query('select public.has_current_publication_evidence($1)', [item.id])).rejects.toMatchObject({ code: '42501' });
      await expect(publish(item)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('returns one immutable release on an identical retry and rejects changed bytes or metadata', async () => {
    const item = await approved(); const first = (await publish(item)).rows[0]!.id;
    expect((await publish(item)).rows[0]!.id).toBe(first);
    expect((await database.query('select id from public.publication_audit where submission_id=$1 and action=\'published\'', [item.id])).rows).toHaveLength(1);
    await expect(publish(item, '다른 제목')).rejects.toThrow('RELEASE_RETRY_CONFLICT');
    await expect(publish({ ...item, report: { ...item.report, artifactSha256: 'a'.repeat(64) } })).rejects.toThrow('RELEASE_HASH_MISMATCH');
  });

  it('blocks a revoked or replaced rights verifier after human approval', async () => {
    const item = await approved();
    await database.query("update public.publication_rights_authorities set revoked_at=now() where key_id='rights'");
    await expect(publish(item)).rejects.toThrow('RELEASE_EVIDENCE_INVALID');
    await database.query("update public.publication_rights_authorities set revoked_at=null,public_key_sha256=$1 where key_id='rights'", ['b'.repeat(64)]);
    await expect(publish(item)).rejects.toThrow('RELEASE_EVIDENCE_INVALID');
    expect((await database.query('select id from public.public_releases where submission_id=$1', [item.id])).rows).toHaveLength(0);
  });

  it('fails closed for expired, malformed or changed scan evidence even after an earlier approval', async () => {
    for (const expiry of ['2020-01-01T00:00:00.000Z', 'infinity', 'not-a-date']) {
      const item = await approved();
      // Direct service mutation models corrupted/stale persisted evidence; clients cannot perform this write.
      await database.query("update public.publication_scans set evidence=jsonb_set(evidence,'{rightsEvidence,expiresAt}',to_jsonb($2::text)) where submission_id=$1", [item.id, expiry]);
      await expect(publish(item)).rejects.toThrow('RELEASE_EVIDENCE_INVALID');
    }
    const item = await approved();
    await database.query("update public.publication_scans set evidence=jsonb_set(evidence,'{sourceSnapshotSha256}',to_jsonb($2::text)) where submission_id=$1", [item.id, 'b'.repeat(64)]);
    await expect(publish(item)).rejects.toThrow('RELEASE_EVIDENCE_INVALID');
  });

  it('requires current evidence to restore suspension and never restores a revoked release', async () => {
    const item = await approved(); const id = (await publish(item)).rows[0]!.id;
    await asUser(database, reviewer); await database.query("select public.moderate_release($1,'suspended','사용자 신고 내용을 확인하는 동안 중단합니다')", [id]);
    await service(); await expect(publish(item)).rejects.toThrow('RELEASE_RETRY_CONFLICT');
    await database.query("update public.publication_rights_authorities set revoked_at=now() where key_id='rights'");
    await asUser(database, reviewer); await expect(database.query("select public.moderate_release($1,'published','권리가 취소된 항목은 복원할 수 없습니다')", [id])).rejects.toThrow('RELEASE_EVIDENCE_INVALID');
    await service(); await database.query("update public.publication_rights_authorities set revoked_at=null where key_id='rights'");
    await asUser(database, reviewer); await database.query("select public.moderate_release($1,'published','현재 권리와 검수 근거를 다시 확인했습니다')", [id]);
    await database.query("select public.moderate_release($1,'revoked','철회된 항목은 새 검수와 새 게시가 필요합니다')", [id]);
    await expect(database.query("select public.moderate_release($1,'published','철회된 항목을 바로 복원하려는 시도입니다')", [id])).rejects.toThrow('REVOKED_RELEASE_NEEDS_NEW_REVIEW');
  });

  it('requires an administrator reviewer for official distribution at publication time', async () => {
    const item = await approved(); await expect(publish(item, '관리자 예제', true)).rejects.toThrow('OFFICIAL_ADMIN_REQUIRED');
    await database.exec('reset role'); await database.query("insert into public.studio_roles values($1,'administrator')", [reviewer]);
    await service(); expect((await publish(item, '관리자 예제', true)).rows).toHaveLength(1);
  });
});
