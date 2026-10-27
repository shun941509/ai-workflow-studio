import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { createBasicWorkflow } from '@studio/spec';
import { buildPackage, buildMaterialsPackage, canonicalDigest, createTextResource } from '@studio/package-kit';
import { collectRequirements } from '@studio/workflow-core';
import { scanPublication, digestBytes, type ScanInput, type ScanReport } from '../../apps/studio-web/src/jobs/publication-scan/scanner';
import { rightsEvidenceBytes, type RightsEvidence } from '../../apps/studio-web/src/jobs/publication-scan/rights';
import { runPublicationScan, type ScanRepository } from '../../apps/studio-web/src/jobs/publication-scan/pipeline';

const now = new Date('2026-10-28T00:00:00.000Z'); const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const rightsTrust = { rights: { publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), purpose: 'redistribution-rights' as const } };
async function project(name = '정적 검사 프로젝트', host: 'codex' | 'claude-code' | 'opencode' = 'codex'): Promise<ScanInput> {
  const workflow = createBasicWorkflow(name); const snapshot = { workflow, editor: {}, sha256: canonicalDigest(workflow) };
  const { bytes } = await buildPackage({ workflow, host });
  return { bytes, source: { kind: 'project', snapshot }, policy: { id: 'test-static', version: '1.0.0', supportedCapabilities: collectRequirements(workflow).capabilities }, now, rightsTrust };
}
function withRights(input: ScanInput, change: Partial<Omit<RightsEvidence, 'signature'>> = {}): ScanInput {
  const body: Omit<RightsEvidence, 'signature'> = { schemaVersion: '1.0.0', artifactSha256: digestBytes(input.bytes), sourceSnapshotSha256: canonicalDigest(input.source.snapshot), scope: 'whole-package', redistribution: true, reviewerId: 'test-rights-reviewer', evidenceSha256: 'e'.repeat(64), reviewedAt: '2026-10-27T00:00:00.000Z', expiresAt: '2036-10-29T00:00:00.000Z', ...change };
  return { ...input, rightsEvidence: { ...body, signature: { keyId: 'rights', value: sign(null, rightsEvidenceBytes(body), privateKey).toString('base64url') } } };
}
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) { const path = resolve(directory); if (dirname(path) !== resolve(tmpdir()) || !path.includes('studio-publication-scan-')) throw new Error('unsafe cleanup'); await rm(path, { recursive: true, force: true }); } });

describe('actual static package scan', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('checks the %s ZIP and binds every finding to exact artifact/manifest/policy hashes', async (host) => {
    const input = withRights(await project('정적 검사', host)); const result = await scanPublication(input); const files = unzipSync(input.bytes);
    expect(result.status).toBe('passed'); expect(Object.values(result.checks).every((value) => value === 'passed')).toBe(true); expect(result.releaseAuthorized).toBe(false); expect(result.artifactSha256).toBe(digestBytes(input.bytes)); expect(result.manifestSha256).toBe(digestBytes(files['manifest.json']!)); const { reportSha256, ...body } = result; expect(reportSha256).toBe(canonicalDigest(body));
  });
  it('does not infer redistribution rights from an intact unsigned package', async () => {
    const result = await scanPublication(await project()); expect(result).toMatchObject({ status: 'needs_evidence', checks: { archive: 'passed', rights: 'unverified' }, rightsEvidence: null, releaseAuthorized: false });
  });
  it.each(['expired', 'artifact', 'source', 'unknown-key', 'mutated'] as const)('rejects %s external rights evidence', async (kind) => {
    let input = withRights(await project(), kind === 'expired' ? { expiresAt: '2026-10-27T12:00:00.000Z' } : kind === 'artifact' ? { artifactSha256: 'a'.repeat(64) } : kind === 'source' ? { sourceSnapshotSha256: 'b'.repeat(64) } : {});
    if (kind === 'unknown-key') input = { ...input, rightsTrust: {} }; if (kind === 'mutated') (input.rightsEvidence as RightsEvidence).reviewerId = 'changed';
    expect((await scanPublication(input)).checks.rights).toBe('unverified');
  });
  it('blocks different workflow bytes even when both the package and its rights evidence are valid', async () => {
    const first = await project('first'), second = await project('second'); const result = await scanPublication(withRights({ ...first, bytes: second.bytes })); expect(result).toMatchObject({ status: 'blocked', checks: { archive: 'passed', source: 'failed' } });
  });
  it('marks malformed ZIP as failed without fabricating a manifest hash or successful missing checks', async () => {
    const input = await project(); const result = await scanPublication({ ...input, bytes: new TextEncoder().encode('not a zip') }); expect(result).toMatchObject({ status: 'blocked', manifestSha256: null, checks: { archive: 'failed', source: 'unverified', rights: 'unverified' } });
  });
  it('redacts detected credentials instead of echoing secret bytes into its report', async () => {
    const secret = `AKIA${'A'.repeat(16)}`; const result = await scanPublication(withRights(await project(secret))); expect(result.checks.secrets).toBe('failed'); expect(result.status).toBe('blocked'); expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('detects quoted JSON credential assignments without emitting their value', async () => {
    const workflow = createBasicWorkflow(); const editor = { api_key: 'non-production-example-secret-value' }; const built = await buildPackage({ workflow, editor, host: 'codex' });
    const result = await scanPublication({ ...(await project()), bytes: built.bytes, source: { kind: 'project', snapshot: { workflow, editor, sha256: canonicalDigest(workflow) } } }); expect(result.checks.secrets).toBe('failed'); expect(JSON.stringify(result)).not.toContain(editor.api_key);
  });
  it('does not mark missing capability implementations or static instruction hazards as passed', async () => {
    const input = withRights(await project('ignore previous instructions')); const result = await scanPublication({ ...input, policy: { ...input.policy, supportedCapabilities: [] } }); expect(result.checks.capabilities).toBe('unverified'); expect(result.checks.staticRisks).toBe('unverified'); expect(result.status).toBe('needs_evidence');
  });
  it('checks an actual materials ZIP and refuses to reinterpret its private-use license as public permission', async () => {
    const content = { format: 'text', kind: 'instruction', name: '개인 지침', description: '', text: '근거를 확인하세요.' }; const resource = createTextResource({ id: 'material', revision: 1, name: content.name, kind: 'instruction', text: content.text });
    const { bytes } = await buildMaterialsPackage({ host: 'codex', refs: { material: resource.reference }, resources: resource.files, name: content.name }); const source = { kind: 'resource' as const, snapshot: { version: { resource_id: 'material', revision: 1, content, sha256: canonicalDigest(content) } } };
    const result = await scanPublication(withRights({ bytes, source, policy: { id: 'test-static', version: '1.0.0', supportedCapabilities: [] }, rightsTrust, now })); expect(result).toMatchObject({ status: 'blocked', checks: { archive: 'passed', source: 'passed', dependencies: 'passed', rights: 'failed' } }); expect(result.findings.map((value) => value.code)).toContain('INCLUDED_LICENSE_RESTRICTS_REDISTRIBUTION');
  });
  it.each(['code', 'binary', 'large'] as const)('marks %s materials unverified and never executes their bytes', async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'studio-publication-scan-')); directories.push(directory); const marker = join(directory, 'must-not-exist');
    const resource = createTextResource({ id: 'material', revision: 1, name: '자료', kind: 'document', text: '본문' });
    const path = kind === 'code' ? 'scripts/payload.js' : kind === 'binary' ? 'assets/content.pdf' : 'assets/large.txt'; const bytes = kind === 'code' ? new TextEncoder().encode(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`) : kind === 'binary' ? Uint8Array.of(0, 255, 100) : new Uint8Array(1024 * 1024 + 1).fill(65);
    const descriptor = { ...resource.descriptor, files: [...resource.descriptor.files, { path, bytes: bytes.length, sha256: digestBytes(bytes) }] }; const descriptorBytes = new TextEncoder().encode(JSON.stringify(descriptor));
    const built = await buildMaterialsPackage({ host: 'codex', refs: { material: { ...resource.reference, sha256: digestBytes(descriptorBytes) } }, resources: { ...resource.files, 'resources/material/resource.json': descriptorBytes, [`resources/material/${path}`]: bytes }, name: '자료 검사' });
    const result = await scanPublication({ ...(await project()), bytes: built.bytes, source: { kind: 'resource', snapshot: {} } }); expect(result.checks.files).toBe('unverified'); expect(result.status).not.toBe('passed'); await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('pinned scan worker pipeline', () => {
  async function localRepository(input: ScanInput) {
    const directory = await mkdtemp(join(tmpdir(), 'studio-publication-scan-')); directories.push(directory); const zip = join(directory, 'candidate.zip'); await writeFile(zip, input.bytes); let commits = 0; let simulateLostReply = false;
    const candidate = { submissionId: 'submission-test', artifactSha256: digestBytes(input.bytes), sourceSnapshotSha256: canonicalDigest(input.source.snapshot), artifactBytes: input.bytes.length, source: input.source };
    const repository: ScanRepository = { async loadCandidate() { return candidate; }, async readCandidate() { return new Uint8Array(await readFile(zip)); }, async previousReport() { try { return JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')) as ScanReport; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }, async recordReport(_id, report) { commits++; await writeFile(join(directory, 'report.json'), JSON.stringify(report)); if (simulateLostReply) throw new Error('SCAN_REPORT_COMMIT_UNCONFIRMED'); } };
    return { repository, candidate, zip, commits: () => commits, loseReply: () => { simulateLostReply = true; } };
  }
  it('recovers a lost commit response from the exact stored report without a duplicate attestation', async () => {
    const input = withRights(await project()); const fixture = await localRepository(input); fixture.loseReply(); await expect(runPublicationScan(fixture.repository, 'submission-test', input)).rejects.toThrow('COMMIT_UNCONFIRMED');
    expect((await runPublicationScan(fixture.repository, 'submission-test', input)).status).toBe('passed'); expect(fixture.commits()).toBe(1);
  });
  it('refuses changed bytes or changed policy even after an earlier success', async () => {
    const input = withRights(await project()); const fixture = await localRepository(input); await runPublicationScan(fixture.repository, 'submission-test', input);
    await expect(runPublicationScan(fixture.repository, 'submission-test', { ...input, policy: { ...input.policy, supportedCapabilities: [] } })).rejects.toThrow('SCAN_REPLAY_CONFLICT');
    await expect(runPublicationScan(fixture.repository, 'submission-test', { ...input, rightsTrust: {} })).rejects.toThrow('SCAN_RIGHTS_RECHECK_REQUIRED');
    await writeFile(fixture.zip, new Uint8Array(input.bytes.length)); await expect(runPublicationScan(fixture.repository, 'submission-test', input)).rejects.toThrow('CANDIDATE_BYTES_MISMATCH'); expect(fixture.commits()).toBe(1);
  });
  it('does not commit any report when immutable source provenance cannot be established', async () => {
    const input = await project(); const fixture = await localRepository(input); fixture.candidate.sourceSnapshotSha256 = 'a'.repeat(64);
    await expect(runPublicationScan(fixture.repository, 'submission-test', input)).rejects.toThrow('CANDIDATE_PIN_MISMATCH'); expect(fixture.commits()).toBe(0);
  });
});
