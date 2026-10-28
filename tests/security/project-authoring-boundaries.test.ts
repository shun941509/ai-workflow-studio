import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBasicWorkflow } from '@studio/spec';

vi.mock('../../apps/studio-web/node_modules/server-only', () => ({}));
const account = vi.hoisted(() => ({ client: undefined as unknown, owner: '10000000-0000-4000-8000-000000000001', authenticate: vi.fn() }));
vi.mock('../../apps/studio-web/src/server/auth', () => ({ authenticatedClient: async () => { account.authenticate(); return { client: account.client, user: { id: account.owner } }; } }));
import { draftPayload, getProject } from '../../apps/studio-web/src/server/projects';
import { POST as exportWorkflow } from '../../apps/studio-web/src/app/api/exports/route';

const requireWeb = createRequire(new URL('../../apps/studio-web/package.json', import.meta.url));
const { createClient } = requireWeb('@supabase/supabase-js') as { createClient: (...args: unknown[]) => unknown };
const request = (body: unknown) => new Request('http://studio.local/api/exports', { method: 'POST', headers: { Origin: 'http://studio.local', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
afterEach(() => { vi.unstubAllGlobals(); account.authenticate.mockReset(); account.client = undefined; });

describe('project authoring boundaries', () => {
  it.each([
    [], { schemaVersion: '2.0.0' }, { debugMode: true },
    { positions: { foreign_node: { x: 0, y: 0 } } },
    { viewport: { center: { x: 0, y: 0 }, zoom: 0 } },
    { subflows: { missing_flow: { positions: {} } } },
  ])('rejects unknown or invalid layout before saving or exporting: %j', async editor => {
    const workflow = createBasicWorkflow();
    expect(() => draftPayload({ workflow, editor })).toThrow(expect.objectContaining({ code: 'EDITOR_INVALID' }));
    const response = await exportWorkflow(request({ host: 'codex', workflow, editor }));
    expect(response.status).toBe(422); expect((await response.json()).error.code).toBe('EDITOR_INVALID');
    expect(account.authenticate).not.toHaveBeenCalled();
  });

  it.each(['codex', 'claude-code', 'opencode'])('preserves exact positions and camera in a production %s ZIP', async host => {
    const workflow = createBasicWorkflow();
    const editor = { positions: Object.fromEntries(workflow.nodes.map((node, index) => [node.id, { x: 150 + 320 * index, y: 280 }])), viewport: { center: { x: 480, y: 300 }, zoom: 1.1 } };
    const draft = draftPayload({ workflow, editor });
    const response = await exportWorkflow(request({ host, workflow, editor })); expect(response.status).toBe(200);
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(JSON.parse(new TextDecoder().decode(files['editor.json']))).toEqual(draft.editor);
    expect(JSON.parse(new TextDecoder().decode(files['workflow.json']))).toEqual(workflow);
    expect(JSON.parse(new TextDecoder().decode(files['manifest.json']))).toMatchObject({ purpose: 'production', targetHost: host });
  });

  it('reads large project pin sets in short exact-version batches and restores their dependency aliases', async () => {
    const projectId = randomUUID(), workflow = createBasicWorkflow();
    const fixed = Array.from({ length: 17 }, (_, index) => ({ alias: `material_${index}`, version_id: randomUUID(), reference: { id: `original_${index}`, revision: 7, kind: 'document', sha256: 'a'.repeat(64) } }));
    const descriptors = fixed.map((row, index) => ({ version_id: row.version_id, reference: row.reference, descriptor: { dependencies: index ? {} : { [fixed[1]!.alias]: fixed[1]!.reference } } }));
    const queries: URL[] = [];
    // SDK emits real PostgREST requests; only the authenticated database transport is replaced.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url); queries.push(url);
      if (url.pathname.endsWith('/projects')) { expect(url.searchParams.get('owner_id')).toBe(`eq.${account.owner}`); return Response.json({ id: projectId, name: workflow.name }); }
      if (url.pathname.endsWith('/project_drafts')) return Response.json({ project_id: projectId, version: 3, workflow, editor: {} });
      if (url.pathname.endsWith('/private_resource_bindings')) return Response.json(fixed);
      if (url.pathname.endsWith('/project_origins')) return Response.json(null);
      expect(url.pathname.endsWith('/resource_archive_versions')).toBe(true);
      const ids = url.searchParams.get('version_id')!.slice(4, -1).split(',');
      expect(ids.length).toBeLessThanOrEqual(8); expect(Number(url.searchParams.get('limit'))).toBe(ids.length);
      return Response.json(descriptors.filter(row => ids.includes(row.version_id)));
    }));
    account.client = createClient('https://authoring-query.example', 'test-anonymous-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const result = await getProject(projectId);
    expect(result.resourceBindings).toEqual(Object.fromEntries(fixed.map(row => [row.alias, row.version_id])));
    expect(result.resourceDependencies.material_0).toEqual(['material_1']);
    expect(queries.filter(url => url.pathname.endsWith('/resource_archive_versions'))).toHaveLength(3);
    // Broken dependency pins cannot become a plausible project merely because their aliases exist.
    descriptors[0]!.descriptor.dependencies.material_1 = { ...fixed[1]!.reference, revision: 8 };
    await expect(getProject(projectId)).rejects.toMatchObject({ code: 'RESOURCE_DEPENDENCY_INVALID' });
  });
});
