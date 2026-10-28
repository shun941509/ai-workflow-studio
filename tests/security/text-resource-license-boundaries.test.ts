import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalDigest, createTextResource, buildMaterialsPackage } from '@studio/package-kit';
import type { TextResourceLicense } from '@studio/spec';
import { scanPublication, digestBytes, type ScanInput } from '../../apps/studio-web/src/jobs/publication-scan/scanner';
import { rightsEvidenceBytes, type RightsEvidence } from '../../apps/studio-web/src/jobs/publication-scan/rights';

// Only the Next server-import marker is replaced; all content, ZIP, hash and signature validation is real.
vi.mock('../../apps/studio-web/node_modules/server-only', () => ({}));
import { normalizeTextResource, materializeStoredResource } from '../../apps/studio-web/src/server/resource-materials';

const id = '4fa55d1b-a602-4d74-8cdc-c3020e09bfe9';
const license: TextResourceLicense = { id: 'MIT', copyrightHolder: '가상 새벽 작업실', copyrightYear: 2026, confirmedAuthority: true };
const request = { name: '검증용 원문 지침', kind: 'instruction', description: '가상 자료의 출처 보존', text: '제공한 원문에서 확인한 사실만 기록하세요.\r\n확인하지 못한 항목은 미확인으로 남기세요.\r\n' };
const now = new Date('2026-10-28T00:00:00.000Z');
// Ephemeral keys exist only in this test process and are never exported as product trust or release evidence.
const keys = generateKeyPairSync('ed25519');
const rightsTrust = { 'test-rights': { purpose: 'redistribution-rights' as const, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } };

/** Builds an actual immutable text version and its exact package; no successful scan result is injected. */
async function candidate(host: 'codex' | 'claude-code' | 'opencode' = 'codex'): Promise<ScanInput> {
  const content = normalizeTextResource({ ...request, license });
  const version = { resource_id: id, revision: 1, content, sha256: canonicalDigest(content) };
  const material = materializeStoredResource(version);
  const archive = await buildMaterialsPackage({ host, name: content.name, refs: { [id]: material.reference }, resources: material.files });
  return { bytes: archive.bytes, source: { kind: 'resource', snapshot: { version } }, policy: { id: 'test-text-license', version: '1.0.0', supportedCapabilities: [] }, rightsTrust, now };
}

/** A reviewer signature is separately bound to the exact package/source and may still fail other scan checks. */
function signRights(input: ScanInput, overrides: Partial<Omit<RightsEvidence, 'signature'>> = {}): ScanInput {
  const body: Omit<RightsEvidence, 'signature'> = {
    schemaVersion: '1.0.0', artifactSha256: digestBytes(input.bytes), sourceSnapshotSha256: canonicalDigest(input.source.snapshot),
    scope: 'whole-package', redistribution: true, reviewerId: 'test-reviewer', evidenceSha256: 'a'.repeat(64),
    reviewedAt: '2026-10-27T00:00:00.000Z', expiresAt: '2026-10-29T00:00:00.000Z', ...overrides,
  };
  return { ...input, rightsEvidence: { ...body, signature: { keyId: 'test-rights', value: sign(null, rightsEvidenceBytes(body), keys.privateKey).toString('base64url') } } };
}

describe('server text revision license boundary', () => {
  it('preserves the canonical old content and default private bytes without introducing a license field', () => {
    const legacy = { format: 'text', ...request };
    const row = { resource_id: id, revision: 3, content: legacy, sha256: canonicalDigest(legacy) };
    const material = materializeStoredResource(row);
    expect(material.content).toEqual(legacy); expect(material.content).not.toHaveProperty('license');
    expect(canonicalDigest(material.content)).toBe(row.sha256);
    expect(material.files).toEqual(createTextResource({ id, revision: 3, name: request.name, kind: 'instruction', text: request.text }).files);
    expect(material.descriptor.license.id).toBe('LicenseRef-Proprietary');
  });

  it.each([undefined, null, { id: 'MIT' }, { ...license, confirmedAuthority: false }, { ...license, confirmedAuthority: 'true' }, { ...license, copyrightHolder: '' }, { ...license, copyrightYear: '2026' }])('rejects a present invalid license instead of silently saving private or MIT terms (%j)', value => {
    expect(() => normalizeTextResource({ ...request, license: value })).toThrow(expect.objectContaining({ status: 422, code: 'RESOURCE_LICENSE_INVALID' }));
  });

  it('pins a detached declaration to immutable content while preserving the original body line endings', () => {
    const input = { ...request, license: structuredClone(license) }, content = normalizeTextResource(input);
    input.license.copyrightHolder = '변경된 가상 저자';
    expect(content.license).toEqual(license); expect(content.text).toBe(request.text);
    const material = materializeStoredResource({ resource_id: id, revision: 1, content, sha256: canonicalDigest(content) });
    expect(material.descriptor.license.id).toBe('MIT');
  });

  it.each(['add', 'remove', 'replace'] as const)('rejects %s license mutation under a stored content hash', operation => {
    const content = normalizeTextResource({ ...request, ...(operation === 'add' ? {} : { license }) });
    const sha256 = canonicalDigest(content);
    const changed: Record<string, unknown> = { ...structuredClone(content) };
    if (operation === 'remove') delete changed.license;
    else changed.license = { ...license, ...(operation === 'replace' ? { copyrightHolder: '다른 가상 저자' } : {}) };
    expect(() => materializeStoredResource({ resource_id: id, revision: 1, content: changed, sha256 })).toThrow(expect.objectContaining({ code: 'RESOURCE_INTEGRITY' }));
  });
});

describe('author declaration is distinct from verified publication rights', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('requires independent rights evidence for an intact MIT %s package', async host => {
    const input = await candidate(host), report = await scanPublication(input);
    expect(report).toMatchObject({ status: 'needs_evidence', checks: { archive: 'passed', source: 'passed', rights: 'unverified' }, rightsEvidence: null, releaseAuthorized: false });
    expect(report.findings).toContainEqual({ check: 'rights', code: 'REDISTRIBUTION_EVIDENCE_REQUIRED', status: 'unverified' });
  });

  it.each(['codex', 'claude-code', 'opencode'] as const)('can verify separate whole-package rights for %s without claiming publication', async host => {
    const input = signRights(await candidate(host)), report = await scanPublication(input);
    expect(report.status).toBe('passed'); expect(Object.values(report.checks).every(value => value === 'passed')).toBe(true);
    expect(report.rightsEvidence).toEqual(input.rightsEvidence); expect(report.releaseAuthorized).toBe(false);
    const { reportSha256, ...body } = report; expect(reportSha256).toBe(canonicalDigest(body));
  });

  it('does not turn an old private resource into public content even with a separate signed assertion', async () => {
    // A separate immutable private source must not inherit the license of another candidate.
    const content = normalizeTextResource(request), version = { resource_id: id, revision: 1, content, sha256: canonicalDigest(content) };
    const material = materializeStoredResource(version);
    const archive = await buildMaterialsPackage({ host: 'codex', name: content.name, refs: { [id]: material.reference }, resources: material.files });
    const report = await scanPublication(signRights({ ...(await candidate()), bytes: archive.bytes, source: { kind: 'resource', snapshot: { version } } }));
    expect(report).toMatchObject({ status: 'blocked', checks: { source: 'passed', rights: 'failed' }, releaseAuthorized: false });
    expect(report.findings.some(finding => finding.code === 'INCLUDED_LICENSE_RESTRICTS_REDISTRIBUTION')).toBe(true);
  });

  it.each(['omitted', 'different-author', 'false-authority', 'stale-hash'] as const)('rejects an MIT package whose immutable source has %s terms', async mutation => {
    const input = await candidate();
    const content: Record<string, unknown> = { ...normalizeTextResource({ ...request, license }) };
    const originalHash = canonicalDigest(content);
    if (mutation === 'omitted') delete content.license;
    else content.license = { ...license, ...(mutation === 'false-authority' ? { confirmedAuthority: false } : { copyrightHolder: '변경된 가상 저자' }) };
    const version = { resource_id: id, revision: 1, content, sha256: mutation === 'stale-hash' ? originalHash : canonicalDigest(content) };
    const report = await scanPublication(signRights({ ...input, source: { kind: 'resource', snapshot: { version } } }));
    expect(report).toMatchObject({ status: 'blocked', checks: { archive: 'passed', source: 'failed' }, releaseAuthorized: false });
  });

  it.each(['expired', 'different-package', 'different-source', 'untrusted', 'tampered'] as const)('keeps MIT rights unverified with %s evidence', async failure => {
    let input = signRights(await candidate(), failure === 'expired' ? { expiresAt: '2026-10-27T12:00:00.000Z' } : failure === 'different-package' ? { artifactSha256: 'b'.repeat(64) } : failure === 'different-source' ? { sourceSnapshotSha256: 'c'.repeat(64) } : {});
    if (failure === 'untrusted') input = { ...input, rightsTrust: {} };
    if (failure === 'tampered') (input.rightsEvidence as RightsEvidence).reviewerId = 'different-reviewer';
    const report = await scanPublication(input);
    expect(report).toMatchObject({ status: 'needs_evidence', checks: { source: 'passed', rights: 'unverified' }, releaseAuthorized: false });
  });
});
