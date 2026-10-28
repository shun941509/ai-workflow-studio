import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalDigest, createTextResource } from '@studio/package-kit';
vi.mock('../../apps/studio-web/node_modules/server-only', () => ({}));
const account = vi.hoisted(() => ({ client: undefined as unknown, options: [] as unknown[], owner: '10000000-0000-4000-8000-000000000001' }));
vi.mock('../../apps/studio-web/src/server/auth', () => ({ authenticatedClient: async (options?: unknown) => { account.options.push(options); return { client: account.client, user: { id: account.owner } }; } }));
import { boundedAccountFetch } from '../../apps/studio-web/src/server/bounded-account-fetch';
import { loadPinnedResourceFiles } from '../../apps/studio-web/src/server/resources';
import { listResourcePage, resourceCursor } from '../../apps/studio-web/src/server/resource-library';

// Use the actual installed SDK so assertions cover emitted PostgREST syntax, not a hand-written query builder.
const requireWeb = createRequire(new URL('../../apps/studio-web/package.json', import.meta.url));
const { createClient } = requireWeb('@supabase/supabase-js') as { createClient: (...args: unknown[]) => unknown };
const origin = 'https://account-query.example';
const readIds = (value: string | null) => value?.match(/^in\.\((.*)\)$/)?.[1]?.split(',') ?? [];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); account.options = []; account.client = undefined; });

function transport(handler: (url: URL) => unknown) {
  const requests: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url); requests.push(url); return Response.json(handler(url)); }));
  account.client = createClient(origin, 'test-anonymous-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: boundedAccountFetch(origin) } });
  return requests;
}
function textVersion(index: number) {
  const id = randomUUID(), content = { format: 'text', name: `고정 자료 ${index}`, kind: 'instruction' as const, description: '', text: `과거 버전 1의 실제 본문 ${index}` };
  const material = createTextResource({ id, revision: 1, name: content.name, kind: content.kind, text: content.text });
  return { id, reference: material.reference, files: material.files, row: { id: randomUUID(), resource_id: id, revision: 1, content, sha256: canonicalDigest(content) } };
}

describe('bounded account resource queries', () => {
  it('selects only exact legacy resource/revision pairs in batches of eight and retains very old pins', async () => {
    const items = Array.from({ length: 17 }, (_, index) => textVersion(index));
    const requests = transport(url => {
      if (url.pathname.endsWith('/resource_versions')) {
        expect(url.searchParams.has('resource_id')).toBe(false);
        const pairs = [...(url.searchParams.get('or') ?? '').matchAll(/and\(resource_id\.eq\.([a-f0-9-]{36}),revision\.eq\.(\d+)\)/g)];
        expect(pairs.length).toBeGreaterThan(0); expect(pairs.length).toBeLessThanOrEqual(8); expect(Number(url.searchParams.get('limit'))).toBe(pairs.length);
        // A resource may have 2,001 newer versions; the query cannot request or allocate their bodies.
        return pairs.map(pair => { expect(pair[2]).toBe('1'); return items.find(item => item.id === pair[1])!.row; });
      }
      expect(url.searchParams.get('owner_id')).toBe(`eq.${account.owner}`); const ids = readIds(url.searchParams.get('id')); expect(ids.length).toBeLessThanOrEqual(8); return ids.map(id => ({ id }));
    });
    const refs = Object.fromEntries(items.map(item => [item.id, item.reference])), result = await loadPinnedResourceFiles(refs);
    expect(result.refs).toEqual(refs); expect(result.files).toEqual(Object.assign({}, ...items.map(item => item.files))); expect(Object.keys(result.bindings)).toHaveLength(17);
    expect(requests.filter(url => url.pathname.endsWith('/resource_versions'))).toHaveLength(3);
    expect(requests.filter(url => url.pathname.endsWith('/resources'))).toHaveLength(3);
  });
  it('loads explicit immutable version IDs in bounded batches and rejects absent ownership', async () => {
    const items = Array.from({ length: 9 }, (_, index) => textVersion(index)); let own = true;
    const requests = transport(url => {
      if (url.pathname.endsWith('/resource_versions')) { const ids = readIds(url.searchParams.get('id')); expect(ids.length).toBeLessThanOrEqual(8); expect(url.searchParams.has('or')).toBe(false); return items.filter(item => ids.includes(item.row.id)).map(item => item.row); }
      return own ? readIds(url.searchParams.get('id')).map(id => ({ id })) : [];
    });
    const refs = Object.fromEntries(items.map(item => [item.id, item.reference])), bindings = Object.fromEntries(items.map(item => [item.id, item.row.id]));
    expect((await loadPinnedResourceFiles(refs, bindings)).bindings).toEqual(bindings); expect(requests.filter(url => url.pathname.endsWith('/resource_versions'))).toHaveLength(2);
    own = false; await expect(loadPinnedResourceFiles(refs, bindings)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
  it('does not replace a missing requested version with a different revision', async () => {
    const item = textVersion(0);
    transport(url => url.pathname.endsWith('/resource_versions') ? [{ ...item.row, revision: 2001 }] : [{ id: item.id }]);
    await expect(loadPinnedResourceFiles({ [item.id]: item.reference })).rejects.toMatchObject({ code: 'RESOURCE_VERSION_MISSING' });
  });
  it('paginates parents independently, bounds each embedded history to101 and discloses truncation', async () => {
    const parents = Array.from({ length: 41 }, (_, index) => ({ id: randomUUID(), name: `자료 ${index}`, kind: 'document', description: '', created_at: `2026-10-28T00:00:${String(59 - index).padStart(2, '0')}.123456+00:00` }));
    const requests = transport(url => {
      const select = url.searchParams.get('select')!; expect(url.searchParams.get('owner_id')).toBe(`eq.${account.owner}`);
      if (!select.includes('resource_versions(')) { expect(url.searchParams.get('limit')).toBe('41'); expect(select).not.toContain('content'); return parents; }
      const ids = readIds(url.searchParams.get('id')); expect(ids.length).toBeLessThanOrEqual(2); expect(url.searchParams.get('resource_versions.limit')).toBe('101'); expect(url.searchParams.get('resource_versions.order')).toBe('revision.desc');
      expect(select).toContain('format:content->>format'); expect(select).not.toContain('revision,content,');
      return ids.map(id => ({ id, resource_versions: Array.from({ length: id === parents[0]!.id ? 101 : 1 }, (_, index) => ({ id: randomUUID(), revision: 101 - index, format: 'text', name: '고정 버전', kind: 'document', description: '' })) }));
    });
    const result = await listResourcePage(null); expect(result.resources).toHaveLength(40); expect(result.resources[0]!.resource_versions).toHaveLength(100);
    expect(result.resources[0]).toHaveProperty('versionsTruncated', true); expect(result.resources[1]).toHaveProperty('versionsTruncated', false);
    expect(requests).toHaveLength(21); expect(account.options).toEqual([{ maxTotalBytes: 16 * 1024 * 1024 }]);
    expect(resourceCursor(result.nextCursor)).toEqual({ createdAt: parents[39]!.created_at, id: parents[39]!.id });
  });
  it('preserves microsecond cursor predicates and rejects injected cursor syntax before querying', async () => {
    const cursor = { createdAt: '2026-10-28T00:00:01.000007+00:00', id: randomUUID() };
    const requests = transport(() => []); await listResourcePage(Buffer.from(JSON.stringify(cursor)).toString('base64url'));
    expect(requests[0]!.searchParams.get('or')).toBe(`(created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id}))`);
    await expect(listResourcePage(Buffer.from(JSON.stringify({ ...cursor, createdAt: `${cursor.createdAt}),id.gt.0` })).toString('base64url'))).rejects.toMatchObject({ code: 'RESOURCE_CURSOR_INVALID' }); expect(requests).toHaveLength(1);
  });
});
