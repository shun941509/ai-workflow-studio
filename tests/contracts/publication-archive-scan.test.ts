import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { createBasicWorkflow, type ResourceRef } from '@studio/spec';
import { buildMaterialsPackage, canonicalDigest, createTextResource, type ResourceDescriptor, type TargetHost } from '@studio/package-kit';
import { collectRequirements } from '@studio/workflow-core';
import { copyArtifact, COPY_RELEASE_ID } from '../helpers/publication-copy';
import { scanPublication, digestBytes, type ScanInput } from '../../apps/studio-web/src/jobs/publication-scan/scanner';
import { runPublicationScan } from '../../apps/studio-web/src/jobs/publication-scan/pipeline';
import { rightsEvidenceBytes, type RightsEvidence } from '../../apps/studio-web/src/jobs/publication-scan/rights';
vi.mock('../../apps/studio-web/node_modules/server-only', () => ({}));
import { prepareVerifiedCopySource } from '../../apps/studio-web/src/server/publication-copy-source';
import { archiveResourceContent } from '../../apps/studio-web/src/server/publication-copy';

const utf8 = (text: string) => new TextEncoder().encode(text);
const policy = { id: 'archive-resource-test', version: '1.0.0', supportedCapabilities: [] };

/** Original fictional documents carry explicit reuse terms; these are internal assets and keys only. */
function material(alias: string, id: string, revision: number, name: string, dependencies: Record<string, ResourceRef> = {}) {
  const payload = { 'document.md': utf8(`# ${name}\r\n이 가상 기관의 자료에서 인용문과 해석을 구분합니다.\r\n`), 'LICENSE.txt': utf8('Original fictional test material. CC0-1.0. Use, modify and redistribute freely.\n') };
  const descriptor: ResourceDescriptor = { schemaVersion: '1.0.0', id, revision, kind: 'document', name, entrypoint: 'document.md', license: { id: 'CC0-1.0', path: 'LICENSE.txt' }, dependencies, requiredConnections: [], files: Object.entries(payload).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digestBytes(bytes) })) as ResourceDescriptor['files'] };
  const definition = utf8(JSON.stringify(descriptor, null, 4) + '\r\n');
  const reference: ResourceRef = { id, revision, kind: 'document', sha256: digestBytes(definition) };
  return { alias, reference, descriptor, files: Object.fromEntries(Object.entries({ ...payload, 'resource.json': definition }).map(([path, bytes]) => [`resources/${alias}/${path}`, bytes])) };
}

/** Source signature, current copy permission, original bytes and archive content construction are real.
 * Only repository lookups are supplied by the test; this is not a live account-copy verification. */
async function fixture(host: TargetHost = 'codex') {
  const guide = material('guide-alias', 'source-guide', 2, '가상 기관 용어 정의');
  const middle = material('policy-alias', 'source-policy', 4, '가상 기관 기록 규칙', { [guide.alias]: guide.reference });
  const root = material('report-alias', 'source-report', 9, '가상 기관 근거 보고', { [middle.alias]: middle.reference });
  const refs = { [guide.alias]: guide.reference, [middle.alias]: middle.reference, [root.alias]: root.reference }, files = { ...guide.files, ...middle.files, ...root.files };
  const workflow = createBasicWorkflow('복사 원본의 실제 자료 연결'); workflow.resources = refs;
  const origin = await copyArtifact({ host, workflow, resources: files }); expect(origin.report.status).toBe('passed');
  const prepared = await prepareVerifiedCopySource({ async resolveCopy() { return structuredClone(origin.record); }, async openPublicObject() { return new Response(origin.bytes); } }, COPY_RELEASE_ID);
  const content = archiveResourceContent(randomUUID(), prepared.snapshot.resources.find(resource => resource.alias === root.alias)!);
  const accountId: string = randomUUID();
  const version = { id: randomUUID(), resource_id: accountId, revision: 1, content, sha256: canonicalDigest(content) };
  const snapshot = { resource: { id: accountId, name: content.name, kind: content.kind }, version };
  const signer = generateKeyPairSync('ed25519'), reviewer = generateKeyPairSync('ed25519');
  const packageTrust = { 'new-materials-signer': signer.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const rightsTrust = { 'new-materials-rights': { purpose: 'redistribution-rights' as const, publicKey: reviewer.publicKey.export({ type: 'spki', format: 'pem' }).toString() } };
  const build = async (references = refs, resources = files) => {
    const built = await buildMaterialsPackage({ host, refs: references, resources, name: content.name }), archive = unzipSync(built.bytes);
    archive['manifest.sig'] = utf8(JSON.stringify({ algorithm: 'Ed25519', keyId: 'new-materials-signer', signature: sign(null, Buffer.from('AI-WORKFLOW-STUDIO/PACKAGE/1\n' + canonicalize(built.manifest)), signer.privateKey).toString('base64url') }));
    return Uint8Array.from(zipSync(archive));
  };
  const authorize = (input: ScanInput): ScanInput => {
    // A fresh grant covers this new package and immutable account snapshot, never the old copy permission.
    const body: Omit<RightsEvidence, 'signature'> = { schemaVersion: '1.0.0', artifactSha256: digestBytes(input.bytes), sourceSnapshotSha256: canonicalDigest(input.source.snapshot), scope: 'whole-package', redistribution: true, reviewerId: 'materials-test-reviewer', evidenceSha256: 'e'.repeat(64), reviewedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2036-01-01T00:00:00.000Z' };
    return { ...input, rightsTrust, rightsEvidence: { ...body, signature: { keyId: 'new-materials-rights', value: sign(null, rightsEvidenceBytes(body), reviewer.privateKey).toString('base64url') } } };
  };
  const input: ScanInput = { bytes: await build(), source: { kind: 'resource', snapshot }, policy, packageTrust };
  return { root, middle, guide, refs, files, origin, content, snapshot, input, build, authorize };
}

describe('archive resource source identity and transitive publication closure', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('scans a real signed %s workflow copy exported as exactly the root materials closure', async host => {
    const item = await fixture(host), result = await scanPublication(item.authorize(item.input));
    expect(result.status).toBe('passed'); expect(Object.values(result.checks)).toEqual(Array(8).fill('passed')); expect(result.releaseAuthorized).toBe(false);
    expect(item.content.reference.revision).toBe(9); expect(item.snapshot.version.revision).toBe(1); expect(item.content.reference.id).not.toBe(item.content.sourceAlias);
    const archive = unzipSync(item.input.bytes); for (const [path, bytes] of Object.entries(item.files)) expect(archive[path]).toEqual(bytes);
    expect(result.sourceSnapshotSha256).toBe(canonicalDigest(item.snapshot)); expect(result.artifactSha256).toBe(digestBytes(item.input.bytes));
  });
  it('never reuses source distribution or private-copy evidence as a new materials distribution grant', async () => {
    const item = await fixture();
    for (const evidence of [undefined, item.origin.record.copyRights.evidence, item.origin.report.rightsEvidence]) {
      const result = await scanPublication({ ...item.input, rightsEvidence: evidence, rightsTrust: item.authorize(item.input).rightsTrust });
      expect(result.checks.source).toBe('passed'); expect(result.checks.rights).toBe('unverified'); expect(result.status).toBe('needs_evidence');
    }
  });
  it('rejects valid but unrelated extra material even when a new grant covers all bytes', async () => {
    const item = await fixture(), extra = material('unrelated', 'other-source', 1, '별개 문서');
    const bytes = await item.build({ ...item.refs, unrelated: extra.reference }, { ...item.files, ...extra.files });
    const report = await scanPublication(item.authorize({ ...item.input, bytes })); expect(report.checks.archive).toBe('passed'); expect(report.checks.rights).toBe('passed'); expect(report.checks.source).toBe('failed'); expect(report.status).toBe('blocked');
  });
  it('rejects the root alias being renamed even when the package remains internally valid', async () => {
    const item = await fixture(), refs = { ...item.refs }; delete refs[item.root.alias]; refs.renamed = item.root.reference;
    const files = Object.fromEntries(Object.entries(item.files).map(([path, bytes]) => [path.replace('resources/report-alias/', 'resources/renamed/'), bytes]));
    const report = await scanPublication(item.authorize({ ...item.input, bytes: await item.build(refs, files) })); expect(report.checks.archive).toBe('passed'); expect(report.checks.source).toBe('failed');
  });
  it('rejects root descriptor reserialization because raw source bytes, not equivalent JSON, are pinned', async () => {
    const item = await fixture(), changed = utf8(JSON.stringify(item.root.descriptor));
    const refs = { ...item.refs, [item.root.alias]: { ...item.root.reference, sha256: digestBytes(changed) } };
    const report = await scanPublication(item.authorize({ ...item.input, bytes: await item.build(refs, { ...item.files, 'resources/report-alias/resource.json': changed }) }));
    expect(report.checks.archive).toBe('passed'); expect(report.checks.source).toBe('failed');
  });
  it.each(['name', 'kind', 'descriptorSha256', 'sourceAlias', 'description', 'extra', 'importId', 'revision', 'account-id', 'content-sha', 'resource-metadata'] as const)('rejects incompatible immutable %s metadata', async field => {
    const item = await fixture(), snapshot = structuredClone(item.snapshot), content = snapshot.version.content as unknown as Record<string, unknown>;
    if (field === 'name') content.name = '다른 원본 제목'; if (field === 'kind') content.kind = 'instruction'; if (field === 'descriptorSha256') content.descriptorSha256 = 'f'.repeat(64); if (field === 'sourceAlias') content.sourceAlias = 'missing'; if (field === 'description') content.description = '추가 문장'; if (field === 'extra') content.storagePath = '../outside.zip'; if (field === 'importId') content.importId = 'invalid';
    if (field === 'revision') snapshot.version.revision = 9; if (field === 'account-id') snapshot.version.resource_id = item.root.reference.id; if (field === 'resource-metadata') snapshot.resource.kind = 'instruction';
    snapshot.version.sha256 = field === 'content-sha' ? 'f'.repeat(64) : canonicalDigest(content);
    const report = await scanPublication(item.authorize({ ...item.input, source: { kind: 'resource', snapshot } })); expect(report.checks.source).toBe('failed'); expect(report.status).toBe('blocked');
  });
  it('refuses removed transitive dependency bytes without claiming a successful source check', async () => {
    const item = await fixture(), files = unzipSync(item.input.bytes); delete files['resources/guide-alias/document.md'];
    const report = await scanPublication(item.authorize({ ...item.input, bytes: Uint8Array.from(zipSync(files)) })); expect(report.status).toBe('blocked'); expect(report.checks.archive).toBe('failed'); expect(report.checks.source).not.toBe('passed');
  });
  it('still blocks a private text license and does not treat archive source support as a license override', async () => {
    const material = createTextResource({ id: 'private', revision: 1, kind: 'instruction', name: '개인 자료', text: '개인용 원문' });
    const content = { format: 'text', name: '개인 자료', kind: 'instruction', text: '개인용 원문' };
    const bytes = (await buildMaterialsPackage({ host: 'codex', refs: { private: material.reference }, resources: material.files, name: content.name })).bytes;
    const item = await fixture(), source = { kind: 'resource' as const, snapshot: { version: { resource_id: 'private', revision: 1, content, sha256: canonicalDigest(content) } } };
    const result = await scanPublication(item.authorize({ bytes, source, policy })); expect(result.checks.source).toBe('passed'); expect(result.checks.rights).toBe('failed'); expect(result.status).toBe('blocked');
  });
  it('refuses replaying a report measured under the previous source-identity policy', async () => {
    const item = await fixture(), { reportSha256: _, ...body } = item.origin.report;
    // This is the measured pre-change fingerprint for delivery-test + the basic workflow capabilities.
    const previousBody = { ...body, policy: { ...body.policy, sha256: '91c0374baca587a1ff4dbb6571e3fd9f11efdf336e0368606729cb1025181b7e' } };
    const recordReport = vi.fn(async () => {});
    await expect(runPublicationScan({
      async loadCandidate() { return { submissionId: 'source-policy-regression', artifactSha256: item.origin.report.artifactSha256, sourceSnapshotSha256: item.origin.report.sourceSnapshotSha256, artifactBytes: item.origin.bytes.length, source: { kind: 'project', snapshot: item.origin.snapshot } }; },
      async readCandidate() { return item.origin.bytes; },
      async previousReport() { return { ...previousBody, reportSha256: canonicalDigest(previousBody) }; }, recordReport,
    }, 'source-policy-regression', { policy: { id: 'delivery-test', version: '1.0.0', supportedCapabilities: collectRequirements(item.origin.workflow).capabilities } })).rejects.toThrow('SCAN_REPLAY_CONFLICT');
    expect(recordReport).not.toHaveBeenCalled();
  });
});
