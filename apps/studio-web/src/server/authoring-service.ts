import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { HttpError } from './http';
import { MAX_DELIVERY_BYTES, readDeliveryBytes } from './publication-delivery';

/** Privileged Storage access is constrained to the configured service origin and bounded before SDK allocation. */
export function authoringServiceClient(signal: AbortSignal) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new HttpError(503, 'AUTHORING_SERVICE_NOT_CONFIGURED', '공개 자료를 개인 계정에 보관하는 서비스 연결이 아직 설정되지 않았습니다.');
  let origin: URL;
  try {
    origin = new URL(url);
    if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error();
  } catch { throw new HttpError(503, 'AUTHORING_SERVICE_NOT_CONFIGURED', '개인 자료 저장 서비스 설정을 확인해야 합니다.'); }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: async (input, init) => {
    const destination = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    if (destination.origin !== origin.origin) throw new Error('AUTHORING_DESTINATION_INVALID');
    const response = await fetch(input, { ...init, redirect: 'error', cache: 'no-store', signal });
    // A private source row includes its bounded 4 MiB preparation plus pinned resolution metadata.
    const maximum = destination.pathname.startsWith('/storage/v1/object/') ? MAX_DELIVERY_BYTES : destination.pathname === '/rest/v1/private_imports' ? 8 * 1024 * 1024 : 4 * 1024 * 1024;
    // Preserve actual empty HTTP errors (notably Storage 404) for the SDK's status-based handling.
    // An empty successful object response still fails validation; only HTTP no-content statuses allow it.
    const bytes = response.body === null && (!response.ok || response.status === 204 || response.status === 205)
      ? new Uint8Array(0) : await readDeliveryBytes(response, maximum, signal, true);
    signal.throwIfAborted(); const headers = new Headers(response.headers);
    headers.delete('content-encoding'); headers.set('content-length', String(bytes.length));
    return new Response(response.status === 204 || response.status === 205 ? null : bytes, { status: response.status, headers });
  } } });
}
