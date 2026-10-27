let csrf = '';

/** Fetch metadata and Origin protect bootstrap; the returned CSRF token remains in memory. */
export async function connect(): Promise<void> {
  const response = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-client': 'local-ui' }, body: '{}' });
  if (!response.ok) throw new Error('Runner 연결을 확인하고 화면을 다시 열어 주세요.');
  const value = await response.json() as { csrf: string };
  csrf = value.csrf;
}

/** Every authenticated request uses both an HttpOnly same-site cookie and a memory-only CSRF header. */
export async function request<T>(path: string, options: { method?: string; body?: unknown; zip?: ArrayBuffer } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: { 'x-studio-csrf': csrf, ...(options.zip ? { 'content-type': 'application/zip' } : options.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: options.zip ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const value = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(value.error?.message ?? '요청을 완료하지 못했습니다.');
  return value;
}

/** Uploaded bytes come only from the browser's explicit file picker; host filesystem paths are never sent. */
export async function uploadFile<T>(path: string, file: File, uploadId: string): Promise<T> {
  const fallback: Record<string, string> = { txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', json: 'application/json', csv: 'text/csv', pdf: 'application/pdf' };
  const mimeType = file.type || fallback[file.name.split('.').at(-1)?.toLowerCase() ?? ''] || 'application/octet-stream';
  const response = await fetch(path, { method: 'POST', headers: { 'x-studio-csrf': csrf, 'content-type': 'application/octet-stream', 'x-studio-filename': encodeURIComponent(file.name), 'x-studio-mime-type': mimeType, 'x-studio-upload-id': uploadId }, body: file });
  const value = await response.json() as T & { error?: { message?: string } }; if (!response.ok) throw new Error(value.error?.message ?? '파일을 전달하지 못했습니다.'); return value;
}

/** Download uses the authenticated bytes route and a user-triggered save, never an inline document renderer. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const response = await fetch(path, { headers: { 'x-studio-csrf': csrf } });
  if (!response.ok) { const value = await response.json() as { error?: { message?: string } }; throw new Error(value.error?.message ?? '파일을 내려받지 못했습니다.'); }
  const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
