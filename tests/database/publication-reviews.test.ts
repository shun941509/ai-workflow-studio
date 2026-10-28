import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createBasicWorkflow } from '@studio/spec';
import { buildPackage, canonicalDigest } from '@studio/package-kit';
import { collectRequirements } from '@studio/workflow-core';
import { asUser, createPolicyDatabase } from './postgres-harness';
import { scanPublication, digestBytes, type ScanReport } from '../../apps/studio-web/src/jobs/publication-scan/scanner';
import { rightsEvidenceBytes, rightsKeyFingerprint, type RightsEvidence } from '../../apps/studio-web/src/jobs/publication-scan/rights';

/** Actual scanner output enters real PostgreSQL functions; no boolean-only scan fixture can open the new review gate. */
describe('pinned candidate scan and human review separation', () => {
  const owner = '10000000-0000-4000-8000-000000000001', reviewer = '20000000-0000-4000-8000-000000000002'; let database: PGlite;
  const keys = generateKeyPairSync('ed25519'); const trust = { rights: { purpose: 'redistribution-rights' as const, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } };
  async function candidate(rights = true, malformed = false) {
    await asUser(database, owner); const workflow = createBasicWorkflow('실제 정적 검사 및 검수');
    const project = await database.query<{ data: { project: { id: string } } }>('select public.create_private_project($1,$2,$3) as data', [workflow.name, workflow, {}]);
    const revision = await database.query<{ data: { id: string } }>('select public.snapshot_private_project($1,1,$2) as data', [project.rows[0]!.data.project.id, canonicalDigest(workflow)]);
    const submitted = await database.query<{ id: string }>("select public.submit_publication('project',$1) as id", [revision.rows[0]!.data.id]); const id = submitted.rows[0]!.id;
    const result = await database.query<{ source_snapshot: unknown }>('select source_snapshot from public.publication_submissions where id=$1', [id]); const snapshot = result.rows[0]!.source_snapshot;
    const bytes = malformed ? new TextEncoder().encode('broken archive') : (await buildPackage({ workflow, host: 'codex' })).bytes;
    const body: Omit<RightsEvidence, 'signature'> = { schemaVersion: '1.0.0', artifactSha256: digestBytes(bytes), sourceSnapshotSha256: canonicalDigest(snapshot), scope: 'whole-package', redistribution: true, reviewerId: 'rights-reviewer', evidenceSha256: 'e'.repeat(64), reviewedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2036-01-01T00:00:00.000Z' };
    const report = await scanPublication({ bytes, source: { kind: 'project', snapshot }, policy: { id: 'test-static', version: '1.0.0', supportedCapabilities: collectRequirements(workflow).capabilities }, rightsTrust: trust, ...(rights ? { rightsEvidence: { ...body, signature: { keyId: 'rights', value: sign(null, rightsEvidenceBytes(body), keys.privateKey).toString('base64url') } } } : {}) });
    return { id, report, bytes, snapshot };
  }
  async function pin(value: Awaited<ReturnType<typeof candidate>>) { await database.exec('reset role; set role service_role'); return database.query('select public.register_publication_candidate($1,$2,$3,$4)', [value.id, value.report.artifactSha256, value.report.sourceSnapshotSha256, value.bytes.length]); }
  const record = (id: string, report: ScanReport) => database.query('select public.record_publication_scan($1,$2,$3,$4,$5,$6,$7,$8)', [id, report.artifactSha256, report.manifestSha256, report.status === 'passed', report.checks.rights === 'passed', report.checks.dependencies === 'passed', report.checks.secrets === 'passed', report]);
  beforeAll(async () => { database = await createPolicyDatabase([owner, reviewer]); for (const name of ['002-publications.sql', '003-public-release-metadata.sql', '004-public-release-search.sql', '005-publication-candidates.sql', '006-review-readiness.sql']) await database.exec(await readFile(new URL(`../../infrastructure/supabase/migrations/${name}`, import.meta.url), 'utf8')); await database.query("insert into public.studio_roles values($1,'reviewer')", [reviewer]); await database.query("insert into public.publication_rights_authorities(key_id,public_key_sha256) values('rights',$1)", [rightsKeyFingerprint(trust.rights)]); }, 30000);
  afterAll(async () => { await database?.close(); });

  it('refuses unregistered/changed candidate bytes and reserves pin/scan authority for the service worker', async () => {
    const item = await candidate(); await asUser(database, reviewer);
    await expect(database.query('select public.register_publication_candidate($1,$2,$3,$4)', [item.id, item.report.artifactSha256, item.report.sourceSnapshotSha256, item.bytes.length])).rejects.toMatchObject({ code: '42501' });
    await expect(record(item.id, item.report)).rejects.toMatchObject({ code: '42501' }); await expect(database.query('select storage_path from public.publication_candidates')).rejects.toMatchObject({ code: '42501' });
    await database.exec('reset role; set role service_role'); await expect(record(item.id, item.report)).rejects.toThrow('SCAN_EVIDENCE_MISMATCH'); await pin(item); await pin(item);
    await expect(database.query('select public.register_publication_candidate($1,$2,$3,$4)', [item.id, 'a'.repeat(64), item.report.sourceSnapshotSha256, item.bytes.length])).rejects.toThrow('CANDIDATE_CONFLICT');
  });

  it('rejects report flags/hash/source inconsistencies even from the worker boundary', async () => {
    const item = await candidate(); await pin(item);
    await expect(record(item.id, { ...item.report, sourceSnapshotSha256: 'b'.repeat(64) })).rejects.toThrow('SCAN_EVIDENCE_MISMATCH');
    await expect(record(item.id, { ...item.report, checks: { ...item.report.checks, files: 'unverified' } })).rejects.toThrow('SCAN_RESULT_MISMATCH');
    await expect(record(item.id, { ...item.report, checks: { ...item.report.checks, files: null } } as unknown as ScanReport)).rejects.toThrow('SCAN_EVIDENCE_MISMATCH');
    await expect(database.query("select public.record_publication_scan($1,$2,$3,true,true,true,true,'{}'::jsonb)", [item.id, item.report.artifactSha256, item.report.manifestSha256])).rejects.toThrow('SCAN_EVIDENCE_MISMATCH');
  });

  it('stores a complete actual scan, then permits only a reviewer decision on the exact scanned bytes', async () => {
    const item = await candidate(); expect(item.report.status).toBe('passed'); await pin(item); await record(item.id, item.report);
    await asUser(database, owner); await expect(database.query('select public.publication_review_readiness($1)', [item.id])).rejects.toMatchObject({ code: '42501' });
    await database.exec('reset role; set role anon'); await expect(database.query('select public.publication_review_readiness($1)', [item.id])).rejects.toMatchObject({ code: '42501' });
    await asUser(database, owner); await expect(database.query("select public.review_publication($1,$2,'approved','원본 소유자는 검수 권한이 없습니다')", [item.id, item.report.artifactSha256])).rejects.toMatchObject({ code: '42501' });
    await asUser(database, reviewer); await expect(database.query("select public.review_publication($1,$2,'approved','다른 바이트 승인 불가')", [item.id, 'a'.repeat(64)])).rejects.toThrow('REVIEW_HASH_MISMATCH');
    const readiness = await database.query<{ value: Record<string, unknown> }>('select public.publication_review_readiness($1) as value', [item.id]); expect(readiness.rows[0]!.value).toMatchObject({ status: 'scanned', canApprove: true, canReject: true, artifactSha256: item.report.artifactSha256, rights: { state: 'active' }, blockedReasons: [] }); expect(JSON.stringify(readiness.rows[0]!.value)).not.toMatch(/storage_path|public_key|source_snapshot|owner_id/);
    await database.query("select public.review_publication($1,$2,'approved','고정 보고서와 실제 후보를 검토했습니다')", [item.id, item.report.artifactSha256]);
    expect((await database.query<{ status: string }>('select status from public.publication_submissions where id=$1', [item.id])).rows[0]!.status).toBe('approved'); expect((await database.query('select id from public.public_releases')).rows).toHaveLength(0);
    expect((await database.query<{ value: Record<string, unknown> }>('select public.publication_review_readiness($1) as value', [item.id])).rows[0]!.value).toMatchObject({ canApprove: false, canReject: false, published: false });
    await expect(database.query('select public.publish_reviewed_release($1,$2,$3,$4,$5,false)', [item.id, item.report.artifactSha256, 'No automatic publish', '', 'releases/example/codex.zip'])).rejects.toMatchObject({ code: '42501' });
  });

  it('retains inspection failures and missing evidence as changes_requested instead of scanned', async () => {
    for (const malformed of [false, true]) {
      const item = await candidate(false, malformed); await pin(item); await record(item.id, item.report); await asUser(database, reviewer);
      expect((await database.query<{ status: string }>('select status from public.publication_submissions where id=$1', [item.id])).rows[0]!.status).toBe('changes_requested');
      expect((await database.query<{ value: Record<string, unknown> }>('select public.publication_review_readiness($1) as value', [item.id])).rows[0]!.value).toMatchObject({ canApprove: false, canReject: false, rights: { state: 'unverified' } });
      await expect(database.query("select public.review_publication($1,$2,'approved','검사 불능을 승인할 수 없습니다')", [item.id, item.report.artifactSha256])).rejects.toThrow('INVALID_PUBLICATION_STATE');
      if (malformed) expect((await database.query<{ manifest_sha256: string | null }>('select manifest_sha256 from public.publication_scans where submission_id=$1', [item.id])).rows[0]!.manifest_sha256).toBeNull();
    }
  });

  it('blocks stale rights evidence at approval even when it was valid at scan time', async () => {
    const item = await candidate(); await pin(item); const expired = { ...item.report, rightsEvidence: { ...item.report.rightsEvidence!, expiresAt: '2020-01-01T00:00:00.000Z' } }; await record(item.id, expired); await asUser(database, reviewer);
    await expect(database.query("select public.review_publication($1,$2,'approved','기간이 지난 근거입니다')", [item.id, item.report.artifactSha256])).rejects.toThrow('REVIEW_EVIDENCE_EXPIRED');
    expect((await database.query<{ value: Record<string, unknown> }>('select public.publication_review_readiness($1) as value', [item.id])).rows[0]!.value).toMatchObject({ canApprove: false, canReject: true, rights: { state: 'expired' } });
  });

  it('rejects direct approval after verifier revocation and denies reviewers registry writes', async () => {
    const item = await candidate(); await pin(item); await record(item.id, item.report); await asUser(database, reviewer);
    await expect(database.query("update public.publication_rights_authorities set revoked_at=null where key_id='rights'")).rejects.toMatchObject({ code: '42501' });
    await database.exec('reset role; set role service_role'); await database.query("update public.publication_rights_authorities set revoked_at=now() where key_id='rights'"); await asUser(database, reviewer);
    await expect(database.query("select public.review_publication($1,$2,'approved','취소된 검증 권한 우회 불가')", [item.id, item.report.artifactSha256])).rejects.toThrow('REVIEW_EVIDENCE_EXPIRED');
    expect((await database.query<{ value: Record<string, unknown> }>('select public.publication_review_readiness($1) as value', [item.id])).rows[0]!.value).toMatchObject({ canApprove: false, canReject: true, rights: { state: 'revoked' } });
  });
});
