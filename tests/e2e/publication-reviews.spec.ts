import { expect, test } from '@playwright/test';

const id = '10000000-0000-4000-8000-000000000001';
const decision = { artifactSha256: 'a'.repeat(64), decision: 'approved', reason: '정확한 후보 바이트에 대한 검토 사유입니다.' };

/** Actual local endpoints must preserve the missing-configuration boundary instead of manufacturing privileged success. */
test('review queue/detail clearly require configured authenticated services', async ({ request }) => {
  for (const path of ['/api/admin/reviews', `/api/admin/reviews/${id}`]) { const response = await request.get(path); expect(response.status()).toBe(503); expect(response.headers()['cache-control']).toBe('no-store'); expect(await response.json()).toMatchObject({ error: { code: 'CLOUD_NOT_CONFIGURED' } }); }
  for (const query of ['?status=unknown', '?limit=999', '?status=scanned&status=approved', '?before=2026-10-28T00:00:00Z']) expect((await request.get(`/api/admin/reviews${query}`)).status()).toBe(400);
});

test('review decisions reject foreign Origin, pass flags and malformed bodies before any RPC', async ({ request, baseURL }) => {
  const path = `/api/admin/reviews/${id}`;
  for (const origin of [undefined, 'https://unrelated.invalid']) expect((await request.post(path, { data: decision, headers: origin ? { Origin: origin } : {} })).status()).toBe(403);
  for (const body of [{ ...decision, passed: true }, { ...decision, role: 'administrator' }, { ...decision, decision: 'published' }, { ...decision, artifactSha256: 'invalid' }, { ...decision, reason: '확인' }]) expect((await request.post(path, { data: body, headers: { Origin: baseURL! } })).status()).toBe(400);
  expect((await request.post(path, { data: { ...decision, reason: 'x'.repeat(21000) }, headers: { Origin: baseURL! } })).status()).toBe(413);
  const response = await request.post(path, { data: decision, headers: { Origin: baseURL! } }); expect(response.status()).toBe(503); expect((await response.json()).saved).toBeUndefined();
});

test('reviewer paths expose no scan attestation, signer, or automatic publish endpoints', async ({ request, baseURL }) => {
  for (const action of ['scan', 'sign', 'publish']) expect((await request.post(`/api/admin/reviews/${id}/${action}`, { data: decision, headers: { Origin: baseURL! } })).status()).toBe(404);
  expect((await request.get('/api/admin/reviews/not-a-uuid')).status()).toBe(404);
});
