const MAX_BYTES = 32 * 1024 * 1024;

/** The server verifies trust and current rights; the browser additionally matches the received bytes to the visible version. */
export async function receivePublicationArchive(response: Response, releaseId: string, expectedSha256: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'application/zip' || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('공개 ZIP 응답 형식을 확인하지 못했습니다.');
  const disposition = response.headers.get('content-disposition') ?? '';
  const matched = /^attachment; filename="workflow-([a-f0-9-]{36})-(codex|claude-code|opencode)\.zip"$/i.exec(disposition);
  if (!matched || matched[1] !== releaseId || !response.body) throw new Error('공개 ZIP 파일 정보를 확인하지 못했습니다.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); }; signal.throwIfAborted(); signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) { const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break; total += chunk.value.byteLength; if (total > MAX_BYTES) { await reader.cancel(); throw new Error('공개 ZIP 크기가 허용된 한도를 넘었습니다.'); } chunks.push(chunk.value); }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join(''); signal.throwIfAborted();
  if (digest !== expectedSha256) throw new Error('받은 파일이 화면의 공개 버전과 다릅니다. 항목을 다시 확인해 주세요.');
  return { blob: new Blob([bytes], { type: 'application/zip' }), filename: `workflow-${releaseId}-${matched[2]}.zip` };
}
