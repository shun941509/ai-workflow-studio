import { expect, test } from '@playwright/test';
const release = '10000000-0000-4000-8000-000000000001';

/** Real local HTTP checks keep missing operator configuration and unsupported requests visibly unsuccessful. */
test('unconfigured delivery returns explicit 503 without an attachment or private locator', async ({ request }) => {
  const response = await request.get(`/api/publications/${release}/download`); expect(response.status()).toBe(503); expect(response.headers()['cache-control']).toBe('no-store'); expect(response.headers()['content-disposition']).toBeUndefined();
  const body = await response.json(); expect(body).toMatchObject({ error: { code: 'DELIVERY_NOT_CONFIGURED' } }); expect(JSON.stringify(body)).not.toMatch(/storage_path|storagePath|source_snapshot|publicKey|sb_secret_|service_role/);
});
test('delivery rejects host conversion, arbitrary object queries and Range requests', async ({ request }) => {
  for (const query of ['?host=opencode', '?path=resources/private.txt', '?passed=true']) expect((await request.get(`/api/publications/${release}/download${query}`)).status()).toBe(400);
  expect((await request.get(`/api/publications/${release}/download`, { headers: { range: 'bytes=0-99' } })).status()).toBe(400); expect((await request.get('/api/publications/not-an-id/download')).status()).toBe(404);
});
test('download endpoint provides no signing, upload or publication mutation', async ({ request }) => {
  for (const method of ['POST', 'PUT', 'DELETE']) expect((await request.fetch(`/api/publications/${release}/download`, { method, data: { passed: true, path: 'arbitrary', key: 'test' } })).status()).toBe(405);
});
