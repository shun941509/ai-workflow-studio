import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { canonicalDigest, createTextResource } from '@studio/package-kit';
import { createBasicWorkflow, createNode } from '@studio/spec';

// Only authentication/database I/O is replaced in these internal tests; materialization and ZIP bytes are real.
vi.mock('server-only', () => ({}));
const boundary = vi.hoisted(() => ({ authenticatedClient: vi.fn() }));
vi.mock('./auth', () => boundary);
import { materializeStoredResource, normalizeTextResource } from './resource-materials';
import { createResource, listResources, loadPinnedResourceFiles } from './resources';
import { POST as exportWorkflow } from '../app/api/exports/route';
import { POST as exportMaterials } from '../app/api/resources/export/route';
import { withResourceAttachment, withoutResourceAttachment } from '../features/editor/resource-links';

const id = '4fa55d1b-a602-4d74-8cdc-c3020e09bfe9';
const content = normalizeTextResource({ name: '출처 보존 지침', kind: 'instruction', description: '확인한 원문만 사용합니다.', text: '원문의 수치와 출처를 보존하고, 없는 정보는 미확인으로 표시하세요.' });
const row = { resource_id: id, revision: 2, content, sha256: canonicalDigest(content) };
const materialized = createTextResource({ id, revision: row.revision, name: content.name, kind: content.kind, text: content.text });
let ownerRows: { id: string }[];
let versionRows: typeof row[];
let resourceRows: unknown[];
let queries: [string, string, unknown][];
let rpc: ReturnType<typeof vi.fn>;

beforeEach(() => {
  ownerRows = [{ id }]; versionRows = [structuredClone(row)]; queries = [];
  resourceRows = [{ id, name: content.name, kind: content.kind, description: content.description, resource_versions: [{ revision: row.revision, content, sha256: row.sha256 }] }];
  rpc = vi.fn(async () => ({ data: { id }, error: null }));
  boundary.authenticatedClient.mockReset().mockResolvedValue({ user: { id: 'actual-session-user' }, client: {
    rpc,
    from(table: string) {
      let selection = '';
      const response = () => ({ data: table === 'resource_versions' ? versionRows : selection.includes('resource_versions') ? resourceRows : ownerRows, error: null });
      const query = {
        select(columns: string) { selection = columns; return query; },
        eq(column: string, value: unknown) { queries.push([table, column, value]); return query; },
        order() { return query; },
        in(_column: string, _values: unknown[]) { return Promise.resolve(response()); },
        limit() { return Promise.resolve(response()); },
      };
      return query;
    },
  } });
});

const request = (url: string, body: unknown) => new Request(`http://studio.local${url}`, { method: 'POST', headers: { Origin: 'http://studio.local', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const refs = () => ({ [id]: structuredClone(materialized.reference) });

describe('private immutable resource materialization', () => {
  test('stores immutable metadata and exposes the descriptor byte hash instead of the DB canonical hash', async () => {
    await createResource({ ...content });
    expect(rpc).toHaveBeenCalledWith('create_private_resource', expect.objectContaining({ p_content: content, p_sha256: row.sha256 }));
    const items = await listResources();
    expect(items[0]?.resource_versions[0]?.reference.sha256).toBe(materialized.reference.sha256);
    expect(materialized.reference.sha256).not.toBe(row.sha256);
    expect(queries).toContainEqual(['resources', 'owner_id', 'actual-session-user']);
  });

  test('rejects canonical content tampering and limits UTF-8 bytes rather than character count', () => {
    expect(() => materializeStoredResource({ ...row, content: { ...content, name: '변경된 이름' } })).toThrow('검증 값');
    expect(() => normalizeTextResource({ ...content, text: '한'.repeat(90000) })).toThrow('256 KiB');
  });

  test('refuses foreign ownership even when a version row is returned by a broken boundary', async () => {
    ownerRows = []; await expect(loadPinnedResourceFiles(refs())).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  test.each(['revision', 'descriptor-hash', 'database-hash', 'identity-alias'] as const)('rejects a changed %s instead of upgrading or trusting browser material', async (change) => {
    const references = refs();
    if (change === 'revision') references[id]!.revision = 3;
    if (change === 'descriptor-hash') references[id]!.sha256 = '0'.repeat(64);
    if (change === 'database-hash') references[id]!.sha256 = row.sha256;
    if (change === 'identity-alias') references[id]!.id = '11c3b4e3-c99f-423f-ae09-d5ba636462a6';
    await expect(loadPinnedResourceFiles(references)).rejects.toThrow();
  });

  test('allows an anonymous empty workflow but authenticates every actual attached resource', async () => {
    await loadPinnedResourceFiles({}); expect(boundary.authenticatedClient).not.toHaveBeenCalled();
    boundary.authenticatedClient.mockRejectedValueOnce(new Error('No real authenticated session'));
    await expect(loadPinnedResourceFiles(refs())).rejects.toThrow('No real authenticated session');
  });
});

describe('operational export routes', () => {
  test.each(['codex', 'claude-code', 'opencode'])('downloads the selected text bytes and original descriptor for %s', async (host) => {
    const response = await exportMaterials(request('/api/resources/export', { host, refs: refs() }));
    expect(response.status).toBe(200);
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(new TextDecoder().decode(files[`resources/${id}/instructions.md`])).toBe(content.text);
    expect(createHash('sha256').update(files[`resources/${id}/resource.json`]!).digest('hex')).toBe(materialized.reference.sha256);
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    expect(manifest.packageKind).toBe('materials'); expect(manifest.purpose).toBe('production'); expect(manifest.targetHost).toBe(host);
    expect(files['workflow.json']).toBeUndefined();
  });

  test('includes pinned material in a workflow and rejects missing references before export', async () => {
    const original = createBasicWorkflow(); const ai = original.nodes.find((node) => node.type === 'ai')!;
    const workflow = withResourceAttachment(original, ai.id, materialized.reference);
    const response = await exportWorkflow(request('/api/exports', { host: 'codex', workflow }));
    expect(response.status).toBe(200);
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(new TextDecoder().decode(files[`resources/${id}/instructions.md`])).toBe(content.text);
    workflow.resources = {};
    const invalid = await exportWorkflow(request('/api/exports', { host: 'codex', workflow }));
    expect(invalid.status).toBe(422); expect((await invalid.json()).error.code).toBe('WORKFLOW_NOT_READY');
  });

  test('materials requests retain strict JSON, origin and non-empty selection boundaries', async () => {
    const foreign = new Request('http://studio.local/api/resources/export', { method: 'POST', headers: { Origin: 'http://foreign.invalid', 'Content-Type': 'application/json' }, body: '{}' });
    expect((await exportMaterials(foreign)).status).toBe(403);
    expect((await exportMaterials(request('/api/resources/export', { host: 'codex', refs: {} }))).status).toBe(422);
  });
});

describe('editor resource version pinning', () => {
  test('preserves other nodes and refuses silently replacing their shared resource version', () => {
    const original = createBasicWorkflow(); const first = original.nodes.find((node) => node.type === 'ai')!;
    const second = createNode('ai'); second.id = 'second_ai'; original.nodes.push(second);
    let workflow = withResourceAttachment(original, first.id, materialized.reference);
    workflow = withResourceAttachment(workflow, second.id, materialized.reference);
    expect(() => withResourceAttachment(workflow, second.id, { ...materialized.reference, revision: 3 })).toThrow('다른 버전');
    workflow = withoutResourceAttachment(workflow, first.id, id); expect(workflow.resources[id]).toEqual(materialized.reference);
    workflow = withoutResourceAttachment(workflow, second.id, id); expect(workflow.resources[id]).toBeUndefined();
    expect(original.resources).toEqual({});
  });
});
