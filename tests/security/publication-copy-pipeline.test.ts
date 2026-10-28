import { describe, expect, it, vi } from 'vitest';
import { canonicalDigest } from '@studio/package-kit';
import { copyArtifact, COPY_RELEASE_ID } from '../helpers/publication-copy';
vi.mock('../../apps/studio-web/node_modules/server-only', () => ({}));
import { copyPublication, type ImportEnvelope, type PrivateCopyRepository, type PrivateImportPreparation } from '../../apps/studio-web/src/server/publication-copy';
import { HttpError } from '../../apps/studio-web/src/server/http';

const owner = '30000000-0000-4000-8000-000000000003', request = '40000000-0000-4000-8000-000000000004', importId = '50000000-0000-4000-8000-000000000005', projectId = '60000000-0000-4000-8000-000000000006';

/** In-memory persistence controls transaction failures; source signatures/ZIP decoding/read-back hashes remain real. */
async function setup() {
  const artifact = await copyArtifact();
  const envelope: ImportEnvelope = { importId, requestId: request, releaseId: COPY_RELEASE_ID, state: 'staging', storage: { bucket: 'authoring-imports', path: `${owner}/${importId}/${artifact.report.artifactSha256}.zip`, bytes: artifact.bytes.length, sha256: artifact.report.artifactSha256 }, resolution: artifact.record, receipt: null };
  let privateBytes: Uint8Array | undefined; let prepared: PrivateImportPreparation | undefined; let preparedHash: string | undefined;
  const receipt = { importId, projectId, resources: [] };
  const repository = {
    begin: vi.fn(async () => structuredClone(envelope)),
    resolveCopy: vi.fn(async () => structuredClone(artifact.record)),
    openPublicObject: vi.fn(async () => new Response(artifact.bytes)),
    putPrivateOnce: vi.fn(async (_path: string, bytes: Uint8Array) => { privateBytes ??= bytes.slice(); }),
    openPrivateObject: vi.fn(async () => new Response(new Uint8Array(privateBytes!))),
    stage: vi.fn(async (_id: string, preparation: PrivateImportPreparation, sha: string, bytes: number, storedSha: string) => {
      expect(bytes).toBe(envelope.storage.bytes); expect(storedSha).toBe(envelope.storage.sha256); expect(sha).toBe(canonicalDigest(preparation));
      if (preparedHash && preparedHash !== sha) throw new Error('conflict'); prepared = structuredClone(preparation); preparedHash = sha;
      return structuredClone(envelope);
    }),
    commit: vi.fn(async (_id: string, sha: string) => {
      expect(sha).toBe(preparedHash); expect(prepared).toBeDefined();
      envelope.state = 'committed'; envelope.receipt = receipt; return structuredClone(envelope);
    }),
    fail: vi.fn(async () => { envelope.state = 'failed'; return structuredClone(envelope); }),
  } satisfies PrivateCopyRepository;
  return { artifact, envelope, receipt, repository, preparation: () => prepared };
}

describe('atomic private authoring copy orchestration', () => {
  it('verifies the source and Storage read-back before staging/commit and returns only a receipt', async () => {
    const item = await setup(); expect(await copyPublication(item.repository, owner, request, COPY_RELEASE_ID)).toEqual(item.receipt);
    expect(item.repository.begin).toHaveBeenCalledWith(owner, request, COPY_RELEASE_ID, expect.any(AbortSignal));
    expect(item.repository.putPrivateOnce).toHaveBeenCalledWith(item.envelope.storage.path, item.artifact.bytes, expect.any(AbortSignal));
    expect(item.repository.openPrivateObject.mock.invocationCallOrder[0]).toBeLessThan(item.repository.stage.mock.invocationCallOrder[0]!);
    expect(item.repository.stage.mock.invocationCallOrder[0]).toBeLessThan(item.repository.commit.mock.invocationCallOrder[0]!);
    expect(item.preparation()?.workflow?.id).toBe(item.artifact.workflow.id); expect(item.preparation()?.source.trust).toBe('verified');
    expect(JSON.stringify(item.receipt)).not.toContain('authoring-imports');
  });
  it('returns the exact committed receipt on retry without new reads, upload or authorization after withdrawal', async () => {
    const item = await setup(); await copyPublication(item.repository, owner, request, COPY_RELEASE_ID);
    const calls = item.repository.resolveCopy.mock.calls.length; item.artifact.record.copyRights.authority.revoked = true;
    expect(await copyPublication(item.repository, owner, request, COPY_RELEASE_ID)).toEqual(item.receipt);
    expect(item.repository.putPrivateOnce).toHaveBeenCalledTimes(1); expect(item.repository.resolveCopy).toHaveBeenCalledTimes(calls); expect(item.repository.commit).toHaveBeenCalledTimes(1);
  });
  it('recovers a commit whose response was lost using the same request ID', async () => {
    const item = await setup(), commit = item.repository.commit.getMockImplementation()!;
    item.repository.commit.mockImplementationOnce(async (id, sha) => { await commit(id, sha); throw new Error('response lost'); });
    await expect(copyPublication(item.repository, owner, request, COPY_RELEASE_ID)).rejects.toThrow('response lost');
    expect(await copyPublication(item.repository, owner, request, COPY_RELEASE_ID)).toEqual(item.receipt); expect(item.repository.putPrivateOnce).toHaveBeenCalledTimes(1);
  });
  it('retries an upload with unknown outcome by reading the existing exact object', async () => {
    const item = await setup(), put = item.repository.putPrivateOnce.getMockImplementation()!;
    item.repository.putPrivateOnce.mockImplementationOnce(async (path, bytes) => { await put(path, bytes); throw new Error('upload response lost'); });
    await expect(copyPublication(item.repository, owner, request, COPY_RELEASE_ID)).rejects.toThrow('upload response lost'); expect(item.repository.stage).not.toHaveBeenCalled();
    expect(await copyPublication(item.repository, owner, request, COPY_RELEASE_ID)).toEqual(item.receipt); expect(item.repository.openPrivateObject).toHaveBeenCalledTimes(1);
  });
  it('rejects a changed stored object before any visible database records are committed', async () => {
    const item = await setup(); item.repository.openPrivateObject.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    await expect(copyPublication(item.repository, owner, request, COPY_RELEASE_ID)).rejects.toMatchObject({ code: 'COPY_STORAGE_INTEGRITY', issues: { requestEnded: true } }); expect(item.repository.stage).not.toHaveBeenCalled(); expect(item.repository.commit).not.toHaveBeenCalled(); expect(item.envelope.state).toBe('failed');
  });
  it('records a confirmed final denial without presenting a receipt or deleting the stored object', async () => {
    const item = await setup(); item.repository.commit.mockRejectedValue(new HttpError(409, 'COPY_NOT_AVAILABLE', '철회됨'));
    await expect(copyPublication(item.repository, owner, request, COPY_RELEASE_ID)).rejects.toMatchObject({ code: 'COPY_NOT_AVAILABLE', issues: { requestEnded: true } }); expect(item.envelope.receipt).toBeNull(); expect(item.envelope.state).toBe('failed');
  });
  for (const change of ['owner-path', 'request', 'release', 'artifact', 'receipt-before-commit'] as const) it(`rejects inconsistent ${change} returned by persistence`, async () => {
    const item = await setup();
    if (change === 'owner-path') item.envelope.storage.path = item.envelope.storage.path.replace(owner, projectId);
    if (change === 'request') item.envelope.requestId = projectId;
    if (change === 'release') item.envelope.releaseId = projectId;
    if (change === 'artifact') { item.envelope.storage.sha256 = 'a'.repeat(64); item.envelope.storage.path = `${owner}/${importId}/${item.envelope.storage.sha256}.zip`; }
    if (change === 'receipt-before-commit') item.envelope.receipt = item.receipt;
    await expect(copyPublication(item.repository, owner, request, COPY_RELEASE_ID)).rejects.toMatchObject({ code: 'COPY_STATE_INVALID' }); expect(item.repository.putPrivateOnce).not.toHaveBeenCalled();
  });
  it('does not store unsupported source presentation data by silently dropping it', async () => {
    const item = await setup(); const artifact = await copyArtifact({ editor: { arbitraryExecutable: 'do not discard' } });
    item.envelope.storage.sha256 = artifact.report.artifactSha256; item.envelope.storage.bytes = artifact.bytes.length; item.envelope.storage.path = `${owner}/${importId}/${artifact.report.artifactSha256}.zip`; item.envelope.resolution = artifact.record;
    item.repository.resolveCopy.mockResolvedValue(artifact.record); item.repository.openPublicObject.mockResolvedValue(new Response(artifact.bytes));
    await expect(copyPublication(item.repository, owner, request, COPY_RELEASE_ID)).rejects.toMatchObject({ code: 'COPY_EDITOR_UNSUPPORTED' }); expect(item.repository.putPrivateOnce).not.toHaveBeenCalled();
  });
  it('rejects an expired or replaced authorization pinned at begin before upload', async () => {
    const item = await setup(); const prior = structuredClone(item.artifact.record); prior.copyRights.authority.revoked = true; item.envelope.resolution = prior;
    await expect(copyPublication(item.repository, owner, request, COPY_RELEASE_ID)).rejects.toMatchObject({ code: 'COPY_RIGHTS_INVALID' }); expect(item.repository.putPrivateOnce).not.toHaveBeenCalled();
  });
  it('never resumes a terminal failed import as though it were still staging', async () => {
    const item = await setup(); item.envelope.state = 'failed';
    await expect(copyPublication(item.repository, owner, request, COPY_RELEASE_ID)).rejects.toMatchObject({ code: 'COPY_PREVIOUSLY_FAILED' }); expect(item.repository.resolveCopy).not.toHaveBeenCalled();
  });
  it('rejects a mismatched stage acknowledgment before commit', async () => {
    const item = await setup(); item.repository.stage.mockResolvedValue({ ...item.envelope, importId: projectId, storage: { ...item.envelope.storage, path: `${owner}/${projectId}/${item.envelope.storage.sha256}.zip` } });
    await expect(copyPublication(item.repository, owner, request, COPY_RELEASE_ID)).rejects.toMatchObject({ code: 'COPY_STATE_INVALID' }); expect(item.repository.commit).not.toHaveBeenCalled();
  });
  it('honors cancellation before authentication-scoped storage mutation begins', async () => {
    const item = await setup(), abort = new AbortController(); abort.abort();
    await expect(copyPublication(item.repository, owner, request, COPY_RELEASE_ID, abort.signal)).rejects.toThrow(); expect(item.repository.begin).not.toHaveBeenCalled();
  });
});
