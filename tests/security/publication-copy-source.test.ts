import { describe, expect, it, vi } from 'vitest';
import { canonicalDigest, createTextResource } from '@studio/package-kit';
import { createBasicWorkflow } from '@studio/spec';
import { createHash, sign } from 'node:crypto';
import { copyArtifact, COPY_RELEASE_ID } from '../helpers/publication-copy';
import { copyRightsEvidenceBytes } from '../../apps/studio-web/src/jobs/publication-scan/copy-rights';
vi.mock('../../apps/studio-web/node_modules/server-only', () => ({}));
import { prepareVerifiedCopySource, verifyCurrentCopyAuthority } from '../../apps/studio-web/src/server/publication-copy-source';

/** Only transport lookups are substituted; Ed25519, ZIP inspection and original resource bytes are real. */
async function setup(options: Parameters<typeof copyArtifact>[0] = {}) {
  const item = await copyArtifact(options);
  expect(item.report.status).toBe('passed');
  const resolveCopy = vi.fn(async () => structuredClone(item.record));
  const openPublicObject = vi.fn(async () => new Response(item.bytes));
  return { ...item, repository: { resolveCopy, openPublicObject } };
}

describe('independently authorized authoring source', () => {
  for (const host of ['codex', 'claude-code', 'opencode'] as const) it(`preserves a signed ${host} source and resources after three current-state checks`, async () => {
    const resource = createTextResource({ id: 'original_ref', revision: 3, kind: 'instruction', name: '원작 지침', text: '실제 원문\r\n바꾸지 않습니다.\r\n' });
    // This synthetic fixture explicitly grants test reuse; a private user's proprietary license must stay blocked.
    const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
    const license = new TextEncoder().encode('LicenseRef-Internal-Test\n이 시험용 원작 자료는 내부 복사·수정 시험에 사용할 수 있습니다.\n');
    resource.files['resources/original_ref/LICENSE.txt'] = license;
    resource.descriptor.license.id = 'LicenseRef-Internal-Test';
    const licenseRecord = resource.descriptor.files.find(file => file.path === 'LICENSE.txt')!; licenseRecord.bytes = license.length; licenseRecord.sha256 = digest(license);
    const descriptor = new TextEncoder().encode(JSON.stringify(resource.descriptor)); resource.files['resources/original_ref/resource.json'] = descriptor; resource.reference.sha256 = digest(descriptor);
    const workflow = createBasicWorkflow('원작 프로젝트'); workflow.resources = { original_ref: resource.reference };
    const item = await setup({ host, workflow, resources: resource.files });
    const result = await prepareVerifiedCopySource(item.repository, COPY_RELEASE_ID);
    expect(result.bytes).toEqual(item.bytes); expect(result.snapshot.workflow).toEqual(workflow);
    expect(result.snapshot.resourceFiles).toEqual(resource.files); expect(result.snapshot.resources[0]?.reference).toEqual(resource.reference);
    expect(result.authority.copyRights.evidenceSha256).toBe(canonicalDigest(item.record.copyRights.evidence));
    expect(item.repository.resolveCopy).toHaveBeenCalledTimes(3); expect(item.repository.openPublicObject).toHaveBeenCalledTimes(1);
  });
  it('does not infer copy permission from a valid distribution grant', async () => {
    const item = await setup(); item.repository.resolveCopy.mockResolvedValue({ delivery: item.record.delivery } as never);
    await expect(prepareVerifiedCopySource(item.repository, COPY_RELEASE_ID)).rejects.toMatchObject({ code: 'COPY_RIGHTS_INVALID' }); expect(item.repository.openPublicObject).not.toHaveBeenCalled();
  });
  for (const boundary of ['signature', 'evidence-hash', 'key-fingerprint', 'revoked', 'expired', 'source', 'scope'] as const) it(`rejects invalid ${boundary} before object access`, async () => {
    const item = await setup(), rights = item.record.copyRights;
    if (boundary === 'signature') { rights.evidence.signature.value = 'A'.repeat(86); rights.evidenceSha256 = canonicalDigest(rights.evidence); }
    if (boundary === 'evidence-hash') rights.evidenceSha256 = 'f'.repeat(64);
    if (boundary === 'key-fingerprint') rights.authority.publicKeySha256 = 'f'.repeat(64);
    if (boundary === 'revoked') rights.authority.revoked = true;
    if (boundary === 'expired') rights.authority.expiresAt = '2020-01-01T00:00:00.000Z';
    if (boundary === 'source') { rights.evidence.sourceSnapshotSha256 = 'f'.repeat(64); rights.evidenceSha256 = canonicalDigest(rights.evidence); }
    if (boundary === 'scope') { (rights.evidence as unknown as Record<string, unknown>).privateCopy = false; rights.evidenceSha256 = canonicalDigest(rights.evidence); }
    await expect(prepareVerifiedCopySource(item.repository, COPY_RELEASE_ID)).rejects.toMatchObject({ code: 'COPY_RIGHTS_INVALID' }); expect(item.repository.openPublicObject).not.toHaveBeenCalled();
  });
  it('blocks revocation during the object stream before exposing source bytes', async () => {
    const item = await setup(); item.repository.openPublicObject.mockImplementation(async () => { item.record.copyRights.authority.revoked = true; return new Response(item.bytes); });
    await expect(prepareVerifiedCopySource(item.repository, COPY_RELEASE_ID)).rejects.toMatchObject({ code: 'COPY_RIGHTS_INVALID' });
  });
  it('requires the exact same current rights even if a replacement grant is independently valid', async () => {
    const item = await setup(); const changed = structuredClone(item.record);
    changed.copyRights.evidence.evidenceSha256 = 'd'.repeat(64);
    const { signature: _, ...body } = changed.copyRights.evidence;
    changed.copyRights.evidence.signature.value = sign(null, copyRightsEvidenceBytes(body), item.key.privateKey).toString('base64url'); changed.copyRights.evidenceSha256 = canonicalDigest(changed.copyRights.evidence);
    item.repository.resolveCopy.mockResolvedValueOnce(structuredClone(item.record)).mockResolvedValueOnce(changed);
    await expect(prepareVerifiedCopySource(item.repository, COPY_RELEASE_ID)).rejects.toMatchObject({ code: 'COPY_SOURCE_CHANGED' });
  });
  it('rechecks current rights after decoding resources, not merely after download', async () => {
    const item = await setup(); const revoked = structuredClone(item.record); revoked.copyRights.authority.revoked = true;
    item.repository.resolveCopy.mockResolvedValueOnce(structuredClone(item.record)).mockResolvedValueOnce(structuredClone(item.record)).mockResolvedValueOnce(revoked);
    await expect(prepareVerifiedCopySource(item.repository, COPY_RELEASE_ID)).rejects.toMatchObject({ code: 'COPY_RIGHTS_INVALID' }); expect(item.repository.resolveCopy).toHaveBeenCalledTimes(3);
  });
  it('rejects changed raw bytes and unsigned archives despite valid separate rights', async () => {
    const item = await setup(); const changed = item.bytes.slice(); changed[1] = changed[1]! ^ 1;
    item.repository.openPublicObject.mockResolvedValue(new Response(changed)); await expect(prepareVerifiedCopySource(item.repository, COPY_RELEASE_ID)).rejects.toMatchObject({ code: 'DELIVERY_INTEGRITY' });
    const unsigned = await setup({ signed: false }); await expect(prepareVerifiedCopySource(unsigned.repository, COPY_RELEASE_ID)).rejects.toMatchObject({ code: 'DELIVERY_INTEGRITY' });
  });
  it('owns checked authority records and rejects unknown or excessive envelope data', async () => {
    const item = await setup(); const checked = verifyCurrentCopyAuthority(item.record, COPY_RELEASE_ID); item.record.copyRights.authority.revoked = true; expect(checked.copyRights.authority.revoked).toBe(false);
    expect(() => verifyCurrentCopyAuthority({ ...checked, clientApproved: true }, COPY_RELEASE_ID)).toThrow();
    expect(() => verifyCurrentCopyAuthority({ ...checked, copyRights: { ...checked.copyRights, arbitrary: 'x'.repeat(21000) } }, COPY_RELEASE_ID)).toThrow();
  });
  it('honors cancellation without starting a private object or copy operation', async () => {
    const item = await setup(), controller = new AbortController(); controller.abort();
    await expect(prepareVerifiedCopySource(item.repository, COPY_RELEASE_ID, controller.signal)).rejects.toThrow(); expect(item.repository.openPublicObject).not.toHaveBeenCalled(); expect(item.repository.resolveCopy).not.toHaveBeenCalled();
  });
});
