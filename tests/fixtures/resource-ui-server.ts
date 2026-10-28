import { build } from 'esbuild';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createBasicWorkflow, type Workflow } from '@studio/spec';
import { buildMaterialsPackage, buildPackage, type TargetHost } from '@studio/package-kit';
import { resourceFixture, legacyTextFixture, accountId } from './resource-ui';
import { attachResourceSelection } from '../../apps/studio-web/src/features/editor/resource-state';
import { normalizeLayout } from '../../apps/studio-web/src/features/editor/local-drafts';

/** This test-only server verifies exact source bytes and bindings while replacing only unavailable account transport. */
export async function startResourceUiHarness() {
  const bundle = await build({ entryPoints: [resolve('tests/fixtures/resource-ui-entry.tsx')], bundle: true, write: false, outdir: 'out', platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"' }, nodePaths: [resolve('apps/studio-web/node_modules')], loader: { '.woff2': 'dataurl' }, logLevel: 'silent' });
  const scripts = bundle.outputFiles!.find(file => file.path.endsWith('.js'))!.contents, styles = bundle.outputFiles!.find(file => file.path.endsWith('.css'))!.contents;
  const doc = resourceFixture(1, 'document'), old = resourceFixture(2, 'instruction', [doc]), first = resourceFixture(2, 'instruction', [doc], 2), second = resourceFixture(3, 'instruction', [doc]), skill = resourceFixture(4, 'skill');
  first.summary.resource_versions.push(old.summary.resource_versions[0]!);
  const collection = [first, second, skill, doc, legacyTextFixture(5), ...Array.from({ length: 118 }, (_, index) => resourceFixture(index + 6))];
  const versions = new Map([...collection, old].map(item => [item.detail.version.id, item]));
  const calls: { method: string; path: string; body?: any }[] = [], failures: string[] = [];
  let detailGate: { version: string; promise: Promise<void> } | undefined, detailFailure = false;
  const original = createBasicWorkflow('복사한 프로젝트'); const attached = attachResourceSelection(original, original.nodes.find(node => node.type === 'ai')!.id, first.detail);
  let project = { project: { id: accountId(999) }, draft: { workflow: attached.workflow, editor: normalizeLayout({}, attached.workflow), version: 1, updated_at: '2026-10-28T00:00:00Z' }, resourceBindings: attached.resourceBindings, resourceDependencies: attached.resourceDependencies, origin: first.detail.origin };
  const materialize = (refs: Workflow['resources'], bindings: Record<string, string>) => {
    const files: Record<string, Uint8Array> = {};
    for (const [alias, ref] of Object.entries(refs)) {
      const material = versions.get(bindings[alias]!); assert.ok(material, `unknown account binding ${alias}`); assert.deepEqual(material.detail.refs[alias], ref);
      for (const [path, bytes] of Object.entries(material.files)) if (path.startsWith(`resources/${alias}/`)) files[path] = bytes;
    }
    assert.deepEqual(Object.keys(bindings).sort(), Object.keys(refs).sort()); return files;
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost'), path = url.pathname;
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      if (path === '/bundle.js' || path === '/bundle.css') { response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css'); response.end(path.endsWith('.js') ? scripts : styles); return; }
      if (!path.startsWith('/api/')) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><html lang="ko"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>'); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      calls.push({ method: request.method!, path: request.url!, body });
      if (path === '/api/resources' && request.method === 'GET') { const offset = Number(url.searchParams.get('cursor') ?? 0); send(200, { resources: collection.slice(offset, offset + 40).map(item => item.summary), nextCursor: offset + 40 < collection.length ? String(offset + 40) : null }); return; }
      if (/^\/api\/resources\/[^/]+$/.test(path) && path !== '/api/resources/export') {
        const version = url.searchParams.get('versionId')!; if (detailGate?.version === version) await detailGate.promise;
        if (detailFailure) { send(409, { error: { message: '고정 버전의 원본을 확인할 수 없습니다.' } }); return; }
        const item = versions.get(version); assert.equal(item?.detail.resource.id, path.split('/').at(-1)); send(200, item!.detail); return;
      }
      if (path === '/api/resources/export' || path === '/api/exports') {
        const refs = body.refs ?? body.workflow.resources; const files = materialize(refs, body.resourceBindings); assert.equal(body.resourceDependencies, undefined);
        const archive = path === '/api/resources/export' ? await buildMaterialsPackage({ host: body.host as TargetHost, name: '선택한 자료', refs, resources: files }) : await buildPackage({ host: body.host as TargetHost, workflow: body.workflow, editor: body.editor, resources: files });
        response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="verified.zip"' }); response.end(archive.bytes); return;
      }
      if (path.startsWith('/api/projects')) {
        if (request.method === 'GET') { send(200, project); return; }
        materialize(body.workflow.resources, body.resourceBindings); project = { ...project, draft: { ...project.draft, workflow: body.workflow, editor: body.editor, version: project.draft.version + 1 }, resourceBindings: body.resourceBindings };
        send(200, request.method === 'PATCH' ? { version: project.draft.version } : project); return;
      }
      send(404, { error: { message: 'Unexpected test transport route' } });
    } catch (error) { failures.push(String(error)); send(500, { error: { message: String(error) } }); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}`, collection, first, second, doc, old, skill, calls, failures,
    holdDetail(version: string) { let release!: () => void; detailGate = { version, promise: new Promise(resolve => { release = resolve; }) }; return () => { release(); detailGate = undefined; }; },
    failDetail(value: boolean) { detailFailure = value; },
    addVersionHistory() { const selected = collection.find(item => item.alias === 'original_alias_6')!; const history = Array.from({ length: 100 }, (_, index) => resourceFixture(6, 'instruction', [], 102 - index)); for (const item of history) versions.set(item.detail.version.id, item); selected.summary.resource_versions = history.map(item => item.summary.resource_versions[0]!); selected.summary.versionsTruncated = true; },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
