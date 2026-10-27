/** This is a configuration check, not JWT authentication; Supabase still verifies all sessions and RLS policies. */
export function isPublicSupabaseKey(value: string): boolean {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) return true;
  if (value.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const encoded = value.split('.')[1]!.replaceAll('-', '+').replaceAll('_', '/');
    const payload: unknown = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    return Boolean(payload && typeof payload === 'object' && !Array.isArray(payload) && 'role' in payload && payload.role === 'anon');
  } catch { return false; }
}

/** Never print invalid values: secret/service-role credentials belong exclusively to trusted server jobs. */
export function validatePublicCloudEnvironment(values: { url?: string; publishableKey?: string; legacyAnonKey?: string }): { url: string; key: string } | null {
  // Validate both variables, even if the preferred one is used: Next can inline every NEXT_PUBLIC value.
  for (const key of [values.publishableKey, values.legacyAnonKey]) if (key && !isPublicSupabaseKey(key)) throw new Error('Supabase 웹 설정에는 publishable 키 또는 legacy anon 키만 사용할 수 있습니다. 비밀키·service_role 키를 제거하세요.');
  const key = values.publishableKey || values.legacyAnonKey;
  if (!values.url || !key) return null;
  let url: URL; try { url = new URL(values.url); } catch { throw new Error('Supabase 프로젝트 URL 형식을 확인하세요.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Supabase URL은 HTTPS 프로젝트 주소 또는 로컬 테스트 주소여야 합니다.');
  return { url: url.origin, key };
}

/** Literal environment references allow Next to inline only explicitly public configuration. */
export function publicCloudConfiguration(): { url: string; key: string } | null {
  return validatePublicCloudEnvironment({ url: process.env.NEXT_PUBLIC_SUPABASE_URL, publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, legacyAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY });
}
