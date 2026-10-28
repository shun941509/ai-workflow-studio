import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalDigest, createTextResource, prepareAuthoringImport } from '@studio/package-kit';
import { createBasicWorkflow } from '@studio/spec';
import { copyArtifact } from '../helpers/publication-copy';
vi.mock('../../apps/studio-web/node_modules/server-only', () => ({}));
import { archiveResourceContent, privateImportPreparation } from '../../apps/studio-web/src/server/publication-copy';
import { materializeArchiveResources, parseArchiveResourceVersion } from '../../apps/studio-web/src/server/archive-resource-materials';

const owner = '30000000-0000-4000-8000-000000000003', importId = '50000000-0000-4000-8000-000000000005', resourceId = '60000000-0000-4000-8000-000000000006', versionId = '70000000-0000-4000-8000-000000000007';

/** Original descriptor whitespace and CRLF survive account UUID allocation and later re-export materialization. */
async function setup() {
  const material = createTextResource({ id: 'original_id', revision: 5, kind: 'document', name: '복사한 원작', text: '자료 원본\r\n정확한 바이트\r\n' });
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const license = new TextEncoder().encode('LicenseRef-Test-Only\nPermission for internal copying and export tests.\n');
  material.descriptor.license.id = 'LicenseRef-Test-Only'; const row = material.descriptor.files.find(file => file.path === 'LICENSE.txt')!; row.bytes = license.length; row.sha256 = sha(license);
  material.files['resources/original_id/LICENSE.txt'] = license;
  const definition = new TextEncoder().encode(JSON.stringify(material.descriptor, null, 4) + '\r\n'); material.reference.sha256 = sha(definition); material.files['resources/original_id/resource.json'] = definition;
  const alias = 'source_docs'; const files = Object.fromEntries(Object.entries(material.files).map(([path, bytes]) => [path.replace('original_id/', `${alias}/`), bytes]));
  const workflow = createBasicWorkflow('원본 자료 재사용'); workflow.resources = { [alias]: material.reference };
  const item = await copyArtifact({ workflow, resources: files }); expect(item.report.status).toBe('passed');
  const snapshot = await prepareAuthoringImport(item.bytes, { trustStore: { [item.keyId]: item.publicKey }, requireSignature: true });
  const preparation = privateImportPreparation(importId, snapshot), content = archiveResourceContent(importId, snapshot.resources[0]!);
  const version = { id: versionId, resource_id: resourceId, revision: 1, content, sha256: canonicalDigest(content) };
  const source = { id: importId, owner_id: owner, state: 'committed', storage_deleted_at: null, artifact_sha256: item.report.artifactSha256, artifact_bytes: item.bytes.length, storage_path: `${owner}/${importId}/${item.report.artifactSha256}.zip`, resolution: item.record, preparation, preparation_sha256: canonicalDigest(preparation) };
  const repository = { source: vi.fn(async () => structuredClone(source)), openObject: vi.fn(async () => new Response(item.bytes)) };
  return { item, alias, files, version, source, repository, selection: { alias, reference: material.reference, version } };
}

describe('copied archive materialization', () => {
  it('keeps account IDs separate from source IDs, revisions, aliases and original bytes', async () => {
    const item = await setup(); const files = await materializeArchiveResources(item.repository, owner, [item.selection]);
    expect(files).toEqual(item.files); expect(item.version.revision).toBe(1); expect(item.version.content.reference.revision).toBe(5); expect(item.version.content.reference.id).toBe('original_id');
    expect(item.repository.source).toHaveBeenCalledWith(owner, importId, expect.any(AbortSignal)); expect(item.repository.openObject).toHaveBeenCalledWith(item.source.storage_path, expect.any(AbortSignal));
  });
  it('does not treat later publication withdrawal as a new public copying grant or erase an already committed private copy', async () => {
    const item = await setup(); item.source.resolution.copyRights.authority.revoked = true; item.source.resolution.copyRights.evidence.expiresAt = '2020-01-01T00:00:00.000Z';
    // Current public grants are irrelevant here; private ownership and the original signed bytes remain mandatory.
    expect(await materializeArchiveResources(item.repository, owner, [item.selection])).toEqual(item.files);
  });
  for (const change of ['owner', 'uncommitted', 'deleted', 'path', 'hash', 'preparation', 'signing-key'] as const) it(`rejects changed ${change} before returning any material`, async () => {
    const item = await setup();
    if (change === 'owner') item.source.owner_id = resourceId;
    if (change === 'uncommitted') item.source.state = 'staging';
    if (change === 'deleted') item.source.storage_deleted_at = '2026-10-28T00:00:00.000Z' as never;
    if (change === 'path') item.source.storage_path = `other/${item.source.artifact_sha256}.zip`;
    if (change === 'hash') item.source.preparation_sha256 = 'f'.repeat(64);
    if (change === 'preparation') item.source.preparation.name = 'changed';
    if (change === 'signing-key') item.source.resolution.delivery.signingKey.sha256 = 'f'.repeat(64);
    await expect(materializeArchiveResources(item.repository, owner, [item.selection])).rejects.toMatchObject({ code: 'ARCHIVE_RESOURCE_INTEGRITY' }); expect(item.repository.openObject).not.toHaveBeenCalled();
  });
  it('rejects changed stored archive bytes and never falls back to a fresh public download', async () => {
    const item = await setup(); const changed = item.item.bytes.slice(); changed[1] = changed[1]! ^ 1; item.repository.openObject.mockResolvedValue(new Response(changed));
    await expect(materializeArchiveResources(item.repository, owner, [item.selection])).rejects.toMatchObject({ code: 'ARCHIVE_RESOURCE_INTEGRITY' }); expect(item.repository.openObject).toHaveBeenCalledTimes(1);
  });
  it('rejects swapping a reference or alias without rewriting the original descriptor', async () => {
    const item = await setup();
    await expect(materializeArchiveResources(item.repository, owner, [{ ...item.selection, alias: 'different_alias' }])).rejects.toThrow();
    await expect(materializeArchiveResources(item.repository, owner, [{ ...item.selection, reference: { ...item.selection.reference, revision: 6 } }])).rejects.toThrow(); expect(item.repository.openObject).not.toHaveBeenCalled();
  });
  it('rejects tampered version metadata even if a caller recomputes its JSON hash', async () => {
    const item = await setup(); item.version.content.name = 'silently replaced title'; item.version.sha256 = canonicalDigest(item.version.content);
    await expect(materializeArchiveResources(item.repository, owner, [item.selection])).rejects.toMatchObject({ code: 'ARCHIVE_RESOURCE_INTEGRITY' });
  });
  it('rejects duplicate material paths and does not overwrite a previously selected resource', async () => {
    const item = await setup(); await expect(materializeArchiveResources(item.repository, owner, [item.selection, item.selection])).rejects.toMatchObject({ code: 'RESOURCE_ALIAS_CONFLICT' }); expect(item.repository.openObject).toHaveBeenCalledTimes(1);
  });
  it('uses owned content snapshots and validates closed metadata rather than trusting format labels', async () => {
    const item = await setup(); const parsed = parseArchiveResourceVersion(item.version); item.version.content.name = 'mutated'; expect(parsed.name).toBe('복사한 원작');
    await expect(materializeArchiveResources(item.repository, owner, [item.selection])).rejects.toThrow();
    expect(() => parseArchiveResourceVersion({ ...item.version, content: { ...parsed, storagePath: 'arbitrary' }, sha256: canonicalDigest({ ...parsed, storagePath: 'arbitrary' }) })).toThrow();
  });
  it('bounds all inspected files across imports even when only one tiny resource is selected from each', async () => {
    const base = await setup(), imports: Record<string, { source: typeof base.source; bytes: Uint8Array }> = {}, selected: typeof base.selection[] = [];
    const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    for (let ordinal = 1; ordinal <= 3; ordinal++) {
      const selectedAlias = `selected_${ordinal}`, id = `90000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
      const unused = createTextResource({ id: 'unused', revision: 1, kind: 'document', name: '선택하지 않은 원작 부록', text: '보관 파일' });
      const license = base.files['resources/source_docs/LICENSE.txt']!; unused.files['resources/unused/LICENSE.txt'] = license; unused.descriptor.license.id = 'LicenseRef-Test-Only';
      const licenseEntry = unused.descriptor.files.find(item => item.path === 'LICENSE.txt')!; licenseEntry.bytes = license.length; licenseEntry.sha256 = sha(license);
      for (let index = 0; index < 700; index++) {
        const path = `appendix/file-${index}.txt`, bytes = new TextEncoder().encode(`source part ${index}`);
        unused.files[`resources/unused/${path}`] = bytes; unused.descriptor.files.push({ path, bytes: bytes.length, sha256: sha(bytes) });
      }
      const definition = new TextEncoder().encode(JSON.stringify(unused.descriptor)); unused.files['resources/unused/resource.json'] = definition; unused.reference.sha256 = sha(definition);
      const files = { ...Object.fromEntries(Object.entries(base.files).map(([path, bytes]) => [path.replace('/source_docs/', `/${selectedAlias}/`), bytes])), ...unused.files };
      const workflow = createBasicWorkflow('선택한 자료 외의 팽창도 제한'); workflow.resources = { [selectedAlias]: base.selection.reference, unused: unused.reference };
      const artifact = await copyArtifact({ workflow, resources: files }); expect(artifact.report.status).toBe('passed');
      const snapshot = await prepareAuthoringImport(artifact.bytes, { trustStore: { [artifact.keyId]: artifact.publicKey }, requireSignature: true }), preparation = privateImportPreparation(id, snapshot);
      const content = archiveResourceContent(id, snapshot.resources.find(item => item.alias === selectedAlias)!);
      const version = { ...base.version, content, sha256: canonicalDigest(content) };
      selected.push({ alias: selectedAlias, reference: base.selection.reference, version });
      imports[id] = { bytes: artifact.bytes, source: { ...base.source, id, storage_path: `${owner}/${id}/${artifact.report.artifactSha256}.zip`, artifact_bytes: artifact.bytes.length, artifact_sha256: artifact.report.artifactSha256, resolution: artifact.record, preparation, preparation_sha256: canonicalDigest(preparation) } };
    }
    const repository = { source: vi.fn(async (_owner: string, id: string) => imports[id]!.source), openObject: vi.fn(async (path: string) => new Response(new Uint8Array(Object.values(imports).find(item => item.source.storage_path === path)!.bytes))) };
    await expect(materializeArchiveResources(repository, owner, selected)).rejects.toMatchObject({ code: 'ARCHIVE_AGGREGATE_LIMIT' }); expect(repository.openObject).toHaveBeenCalledTimes(3);
  }, 30000);
});
