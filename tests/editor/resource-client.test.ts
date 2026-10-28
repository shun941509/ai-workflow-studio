import { afterEach, describe, expect, it, vi } from 'vitest';
import { readResourceDetail, readResourcePage } from '../../apps/studio-web/src/features/resources/resource-client';
import { legacyTextFixture, resourceFixture } from '../fixtures/resource-ui';

const material = resourceFixture(10); const respond = (value: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(value, { status })));
afterEach(() => vi.unstubAllGlobals());
/** Malformed metadata is an explicit UI error; it cannot become a successful preview or attachment. */
describe('resource browser transport contracts', () => {
  it('accepts bounded metadata and encodes cursors without requesting content', async () => {
    respond({ resources: [material.summary], nextCursor: 'next_page' }); expect((await readResourcePage('first_page')).resources).toEqual([material.summary]); expect(fetch).toHaveBeenCalledWith('/api/resources?cursor=first_page', expect.objectContaining({ cache: 'no-store' }));
  });
  it.each([{ resources: Array(41).fill(material.summary), nextCursor: null }, { resources: [{ ...material.summary, versionsTruncated: undefined }], nextCursor: null }, { resources: [{ ...material.summary, resource_versions: Array(101).fill(material.summary.resource_versions[0]) }], nextCursor: null }, { resources: [], nextCursor: '../unsafe' }])('rejects an unbounded or incomplete page', async value => { respond(value); await expect(readResourcePage()).rejects.toThrow(); });
  it('requires the selected immutable account version', async () => {
    respond(material.detail); await expect(readResourceDetail(material.detail.resource.id, 'another-version')).rejects.toThrow(/고정 버전/);
  });
  it.each([{ ...material.detail.version.content, files: 'invalid' }, { format: 'text', name: 'name', kind: 'document', description: '', text: {} }, { ...material.detail.version.content, license: null }])('rejects a malformed preview shape', async content => {
    respond({ ...material.detail, version: { ...material.detail.version, content } }); await expect(readResourceDetail(material.detail.resource.id, material.detail.version.id)).rejects.toThrow();
  });
  it('accepts real private text and archive DTOs without conflating their identity conventions', async () => {
    for (const item of [material, legacyTextFixture(11)]) { respond(item.detail); expect(await readResourceDetail(item.detail.resource.id, item.detail.version.id)).toEqual(item.detail); }
  });
  it('preserves an explicit server denial instead of offering stale content', async () => {
    respond({ error: { message: '이 자료 버전에 접근할 수 없습니다.' } }, 403); await expect(readResourceDetail(material.detail.resource.id, material.detail.version.id)).rejects.toThrow('이 자료 버전에 접근할 수 없습니다.');
  });
});
