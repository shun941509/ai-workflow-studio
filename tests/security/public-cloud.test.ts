import { describe, expect, it } from 'vitest';
import { isPublicSupabaseKey, validatePublicCloudEnvironment } from '../../apps/studio-web/src/config/public-cloud';

/** Synthetic configuration values test key classification only; they never authenticate to a real service. */
describe('public web credential boundary', () => {
  const legacy = (role: string) => `e30.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
  it('uses the publishable key and supports existing anon JWT configurations', () => {
    expect(validatePublicCloudEnvironment({ url: 'https://workspace.supabase.co', publishableKey: 'sb_publishable_internal_test' })).toEqual({ url: 'https://workspace.supabase.co', key: 'sb_publishable_internal_test' });
    expect(isPublicSupabaseKey(legacy('anon'))).toBe(true);
    expect(validatePublicCloudEnvironment({ url: 'http://127.0.0.1:54321', legacyAnonKey: legacy('anon') })?.key).toBe(legacy('anon'));
  });
  it('rejects privileged keys in either public variable without echoing their values', () => {
    for (const secret of ['sb_secret_internal_sentinel', legacy('service_role'), 'sk-proj-internal-sentinel']) {
      expect(isPublicSupabaseKey(secret)).toBe(false);
      for (const values of [{ publishableKey: secret }, { publishableKey: 'sb_publishable_internal_test', legacyAnonKey: secret }]) {
        try { validatePublicCloudEnvironment(values); throw new Error('Expected configuration rejection'); } catch (error) { expect(String(error)).toContain('publishable'); expect(String(error)).not.toContain(secret); }
      }
    }
  });
  it('keeps absent connections explicit and rejects credentials or insecure origins in URLs', () => {
    expect(validatePublicCloudEnvironment({})).toBeNull();
    for (const url of ['https://user:pass@example.org', 'http://remote.example.org', 'https://example.org?key=oops', 'https://example.org/api']) expect(() => validatePublicCloudEnvironment({ url, publishableKey: 'sb_publishable_internal_test' })).toThrow();
  });
});
