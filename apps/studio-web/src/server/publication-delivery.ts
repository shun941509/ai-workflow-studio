import 'server-only';
import { createHash, createPublicKey } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { canonicalDigest, inspectPackage, type TargetHost } from '@studio/package-kit';
import { assertJsonData } from '@studio/spec';
import { authenticatedClient } from './auth';
import { assertId, HttpError } from './http';

export const MAX_DELIVERY_BYTES = 32 * 1024 * 1024;
const MAX_PREPARING = 2;
let preparing = 0;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const checks = ['archive', 'source', 'files', 'secrets', 'capabilities', 'dependencies', 'rights', 'staticRisks'];
export type Delivery = { releaseId: string; submissionId: string; artifactSha256: string; manifestSha256: string; artifactBytes: number; targetHost: TargetHost; storagePath: string; sourceSnapshotSha256: string; report: Record<string, unknown>; signingKey: { id: string; publicKey: string; sha256: string; notBefore: string; expiresAt: string } };
export interface DeliveryRepository {
  /** Only a trusted service lookup may expose this private metadata to the server. */
  resolve(releaseId: string, signal: AbortSignal): Promise<unknown>;
  openObject(storagePath: string, signal: AbortSignal): Promise<Response>;
}

function cancelled(signal: AbortSignal) { if (signal.aborted) throw new HttpError(408, 'DELIVERY_CANCELLED', '다운로드 준비가 취소되거나 제한 시간을 넘었습니다. 다시 요청해 주세요.'); }
function invalid() { return new HttpError(409, 'DELIVERY_INTEGRITY', '고정된 공개 파일의 검증 정보를 확인하지 못했습니다. 다운로드를 중단했습니다.'); }

/** Bound the actual stream before Blob/JSON allocation; Content-Length alone is never trusted. */
export async function readDeliveryBytes(response: Response, maximum: number, signal: AbortSignal, acceptHttpError = false): Promise<Uint8Array<ArrayBuffer>> {
  cancelled(signal);
  if (!acceptHttpError && !response.ok || !response.body) throw new HttpError(503, 'DELIVERY_STORAGE_UNAVAILABLE', '공개 파일 저장소를 확인하지 못했습니다.');
  const length = response.headers.get('content-length');
  // Fetch decodes compressed HTTP responses but retains their original headers. That length describes compressed
  // transport bytes, so only identity responses permit an exact Content-Length check; every actual chunk stays bounded.
  const encoded = !!response.headers.get('content-encoding') && response.headers.get('content-encoding')!.toLowerCase().trim() !== 'identity';
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || !encoded && Number(length) > maximum)) { await response.body.cancel(); throw invalid(); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); }; signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) { const part = await reader.read(); cancelled(signal); if (part.done) break; total += part.value.byteLength; if (total > maximum) { await reader.cancel(); throw invalid(); } chunks.push(part.value); }
    if (length !== null && !encoded && Number(length) !== total) throw invalid();
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes;
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

/** Persisted metadata is still checked at the boundary, including the original scan report hash. */
export function parseDelivery(value: unknown, releaseId: string): Delivery {
  try {
    assertJsonData(value); if (!isObject(value) || !isObject(value.signingKey) || !isObject(value.report)) throw invalid();
    const key = value.signingKey, report = value.report;
    if (value.releaseId !== releaseId || typeof value.submissionId !== 'string') throw invalid(); assertId(value.submissionId);
    if (!digest(value.artifactSha256) || !digest(value.manifestSha256) || !digest(value.sourceSnapshotSha256) || !Number.isSafeInteger(value.artifactBytes) || Number(value.artifactBytes) < 1 || Number(value.artifactBytes) > MAX_DELIVERY_BYTES || !['codex', 'claude-code', 'opencode'].includes(String(value.targetHost))) throw invalid();
    if (value.storagePath !== `releases/${value.submissionId}/${value.artifactSha256}.zip`) throw invalid();
    if (typeof key.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(key.id) || typeof key.publicKey !== 'string' || key.publicKey.length > 4096 || !digest(key.sha256) || typeof key.notBefore !== 'string' || typeof key.expiresAt !== 'string') throw invalid();
    const notBefore = Date.parse(key.notBefore), expiresAt = Date.parse(key.expiresAt);
    if (!Number.isFinite(notBefore) || !Number.isFinite(expiresAt) || notBefore > Date.now() || expiresAt <= Date.now()) throw invalid();
    const publicKey = createPublicKey(key.publicKey); if (publicKey.asymmetricKeyType !== 'ed25519' || hash(publicKey.export({ type: 'spki', format: 'der' })) !== key.sha256) throw invalid();
    const { reportSha256, ...body } = report;
    if (!digest(reportSha256) || canonicalDigest(body) !== reportSha256 || report.schemaVersion !== '1.0.0' || report.scannerVersion !== '1.0.0' || report.status !== 'passed' || report.releaseAuthorized !== false || report.artifactSha256 !== value.artifactSha256 || report.manifestSha256 !== value.manifestSha256 || report.sourceSnapshotSha256 !== value.sourceSnapshotSha256 || report.artifactBytes !== value.artifactBytes || !isObject(report.checks) || Object.keys(report.checks).length !== checks.length || checks.some((name) => (report.checks as Record<string, unknown>)[name] !== 'passed')) throw invalid();
    const rights = report.rightsEvidence; if (!isObject(rights) || typeof rights.expiresAt !== 'string' || !Number.isFinite(Date.parse(rights.expiresAt)) || Date.parse(rights.expiresAt) <= Date.now()) throw invalid();
    // Own this record: a repository/caller cannot mutate the initially checked identity while bytes are being read.
    return structuredClone(value) as unknown as Delivery;
  } catch { throw invalid(); }
}

/** No bytes are returned until a second current-state lookup succeeds after complete ZIP/signature validation. */
export async function preparePublicationDownload(repository: DeliveryRepository, releaseId: string, parentSignal: AbortSignal = new AbortController().signal) {
  assertId(releaseId); const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(30000)]); cancelled(signal);
  const initial = parseDelivery(await repository.resolve(releaseId, signal), releaseId); cancelled(signal);
  const bytes = await readDeliveryBytes(await repository.openObject(initial.storagePath, signal), MAX_DELIVERY_BYTES, signal);
  if (bytes.length !== initial.artifactBytes || hash(bytes) !== initial.artifactSha256) throw invalid();
  try {
    const inspected = await inspectPackage(bytes, { requireSignature: true, trustStore: { [initial.signingKey.id]: initial.signingKey.publicKey }, limits: { maxFiles: 2000, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxManifestBytes: 1024 * 1024 } });
    if (inspected.trust !== 'verified' || inspected.manifest.targetHost !== initial.targetHost || hash(inspected.files.get('manifest.json')!) !== initial.manifestSha256) throw invalid();
  } catch { throw invalid(); }
  cancelled(signal); const current = parseDelivery(await repository.resolve(releaseId, signal), releaseId); cancelled(signal);
  if (canonicalDigest(initial) !== canonicalDigest(current)) throw new HttpError(409, 'DELIVERY_CHANGED', '공개 상태나 검증 정보가 변경되었습니다. 최신 항목을 다시 확인해 주세요.');
  return { bytes, releaseId, host: initial.targetHost, artifactSha256: initial.artifactSha256 };
}

/** Response metadata is derived from validated IDs, never a title, Storage path or untrusted filename. */
export function publicationDownloadResponse(result: Awaited<ReturnType<typeof preparePublicationDownload>>) {
  return new Response(result.bytes, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="workflow-${result.releaseId}-${result.host}.zip"`, 'Content-Length': String(result.bytes.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' } });
}

/** This service credential is never selected from request input or exposed through a browser-visible client. */
export async function downloadConfiguredPublication(releaseId: string, request: Request): Promise<Response> {
  assertId(releaseId);
  if (new URL(request.url).search || request.headers.has('range')) throw new HttpError(400, 'DELIVERY_REQUEST_INVALID', '전체 공개 ZIP만 내려받을 수 있습니다.');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new HttpError(503, 'DELIVERY_NOT_CONFIGURED', '공개 파일 전달 서비스 연결이 아직 설정되지 않았습니다.');
  let origin: URL; try { origin = new URL(url); if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error(); } catch { throw new HttpError(503, 'DELIVERY_NOT_CONFIGURED', '공개 파일 전달 서비스 설정을 확인해야 합니다.'); }
  await authenticatedClient();
  if (preparing >= MAX_PREPARING) throw new HttpError(429, 'DELIVERY_BUSY', '다운로드 준비 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
  preparing++;
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30000)]);
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: async (input, init) => {
      const destination = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (destination.origin !== origin.origin) throw new Error('SERVICE_DESTINATION_INVALID');
      const response = await fetch(input, { ...init, cache: 'no-store', redirect: 'error', signal });
      // The SDK consumes JSON/Blob after this function returns; bound its raw stream first to avoid unbounded allocation.
      const bytes = await readDeliveryBytes(response, destination.pathname.startsWith('/storage/v1/') ? MAX_DELIVERY_BYTES : 4 * 1024 * 1024, signal, true);
      const headers = new Headers(response.headers); headers.delete('content-encoding'); headers.set('content-length', String(bytes.length)); return new Response(bytes, { status: response.status, headers });
    } } });
    const repository: DeliveryRepository = {
      async resolve(id) { const { data, error } = await client.rpc('resolve_publication_delivery', { p_release: id }); if (error) { if (error.message === 'DELIVERY_NOT_AVAILABLE') throw new HttpError(404, 'DELIVERY_NOT_AVAILABLE', '현재 내려받을 수 있는 공개 파일이 없습니다.'); throw new HttpError(503, 'DELIVERY_STATE_UNAVAILABLE', '현재 공개 파일의 권한 상태를 확인하지 못했습니다.'); } return data; },
      async openObject(path) { const { data, error } = await client.storage.from('publication-releases').download(path); if (error || !data) throw new HttpError(503, 'DELIVERY_STORAGE_UNAVAILABLE', '공개 파일을 읽지 못했습니다.'); return new Response(data); },
    };
    return publicationDownloadResponse(await preparePublicationDownload(repository, releaseId, signal));
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, 'DELIVERY_UNAVAILABLE', '공개 ZIP 전달을 확인하지 못했습니다. 다시 요청해 주세요.'); }
  finally { preparing--; }
}
