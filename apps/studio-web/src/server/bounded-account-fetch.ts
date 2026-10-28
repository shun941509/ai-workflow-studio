import 'server-only';
import { HttpError } from './http';

export const ACCOUNT_QUERY_LIMITS = Object.freeze({ responseBytes: 4 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, timeoutMs: 60000 });
export interface AccountFetchOptions { signal?: AbortSignal; maxTotalBytes?: number }
const tooLarge = () => new HttpError(413, 'ACCOUNT_RESPONSE_TOO_LARGE', '계정 자료 조회가 한도를 넘었습니다. 선택한 자료 수를 줄여 다시 확인해 주세요.');

/** One authenticated client gets one shared deadline/byte budget, including concurrent queries.
 * Bytes are bounded before Supabase calls response.json(); Content-Length is never trusted alone. */
export function boundedAccountFetch(origin: string, options: AccountFetchOptions = {}): typeof fetch {
  const configured = new URL(origin), maximumTotal = options.maxTotalBytes ?? ACCOUNT_QUERY_LIMITS.totalBytes;
  if (configured.username || configured.password || configured.pathname !== '/' || configured.search || configured.hash
    || configured.protocol !== 'https:' && !(configured.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname))
    || !Number.isSafeInteger(maximumTotal) || maximumTotal < 1 || maximumTotal > ACCOUNT_QUERY_LIMITS.totalBytes) throw new Error('ACCOUNT_FETCH_CONFIGURATION_INVALID');
  const controller = new AbortController(); let received = 0;
  const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(ACCOUNT_QUERY_LIMITS.timeoutMs), ...(options.signal ? [options.signal] : [])]);
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    if (url.origin !== configured.origin || url.username || url.password) throw new HttpError(503, 'ACCOUNT_DESTINATION_INVALID', '계정 저장소 주소를 확인하지 못했습니다.');
    const signal = AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : []), ...(input instanceof Request ? [input.signal] : [])]);
    signal.throwIfAborted();
    const response = await fetch(input, { ...init, redirect: 'error', cache: 'no-store', signal });
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && (Number(declared) > ACCOUNT_QUERY_LIMITS.responseBytes || Number(declared) > maximumTotal - received)) {
      const error = tooLarge(); controller.abort(error); void response.body?.cancel().catch(() => undefined); throw error;
    }
    const chunks: Uint8Array[] = []; let length = 0;
    if (response.body) {
      const reader = response.body.getReader(), cancel = () => { void reader.cancel().catch(() => undefined); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        signal.throwIfAborted();
        while (true) {
          const part = await reader.read(); signal.throwIfAborted(); if (part.done) break;
          length += part.value.byteLength; received += part.value.byteLength;
          // Synchronous accounting also covers Promise.all consumers sharing the same client.
          if (length > ACCOUNT_QUERY_LIMITS.responseBytes || received > maximumTotal) { const error = tooLarge(); controller.abort(error); throw error; }
          chunks.push(part.value);
        }
      } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
    }
    signal.throwIfAborted(); const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const headers = new Headers(response.headers); headers.delete('content-encoding'); headers.set('content-length', String(length));
    // Preserve Auth cookies/status and PostgREST diagnostics while rejecting redirects before credentials can leave origin.
    return new Response(response.status === 204 || response.status === 205 || response.status === 304 ? null : bytes, { status: response.status, statusText: response.statusText, headers });
  };
}
