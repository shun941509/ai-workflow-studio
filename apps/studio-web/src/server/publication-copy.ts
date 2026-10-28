import 'server-only';
import { createHash } from 'node:crypto';
import { assertJsonData, type ResourceRef } from '@studio/spec';
import { canonicalDigest, type AuthoringImportSnapshot } from '@studio/package-kit';
import { validateImportedLayout } from '../features/editor/local-drafts';
import { HttpError, assertId } from './http';
import { MAX_DELIVERY_BYTES, readDeliveryBytes } from './publication-delivery';
import { prepareVerifiedCopySource, verifyCurrentCopyAuthority, type CopySourceRepository } from './publication-copy-source';

export interface ImportReceipt {
  importId: string; projectId: string | null;
  resources: { alias: string; resourceId: string; versionId: string; revision: 1 }[];
}
export interface ImportEnvelope {
  importId: string; requestId: string; releaseId: string; state: 'staging' | 'committed' | 'failed';
  storage: { bucket: 'authoring-imports'; path: string; bytes: number; sha256: string };
  resolution: unknown; receipt: ImportReceipt | null;
}
export interface PrivateCopyRepository extends CopySourceRepository {
  begin(ownerId: string, requestId: string, releaseId: string, signal: AbortSignal): Promise<unknown>;
  /** Must be conditional creation (upsert false); an existing object is subsequently verified by reading its bytes. */
  putPrivateOnce(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  openPrivateObject(path: string, signal: AbortSignal): Promise<Response>;
  stage(importId: string, preparation: PrivateImportPreparation, preparationSha256: string, storedBytes: number, storedSha256: string, signal: AbortSignal): Promise<unknown>;
  commit(importId: string, preparationSha256: string, signal: AbortSignal): Promise<unknown>;
  /** Only confirmed deterministic failure may end staging; never use this for an unknown network/commit outcome. */
  fail(importId: string, code: string, signal: AbortSignal): Promise<unknown>;
}
export interface ArchiveResourceContent {
  format: 'archive_v1'; importId: string; sourceAlias: string; reference: ResourceRef;
  descriptorSha256: string; name: string; kind: ResourceRef['kind']; description: '';
}
export interface PrivateImportPreparation {
  format: 'private-authoring-v1'; source: AuthoringImportSnapshot['source']; name: string;
  workflow?: AuthoringImportSnapshot['workflow']; editor?: Record<string, unknown>;
  resources: (AuthoringImportSnapshot['resources'][number] & { contentSha256: string })[];
  inventory: AuthoringImportSnapshot['inventory'];
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const corrupt = () => new HttpError(409, 'COPY_STATE_INVALID', '복사 기록과 고정된 원본 정보를 확인하지 못했습니다.');
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

/** Public receipts contain only owned result IDs, never Storage paths, signing trust or archive content. */
export function parseImportReceipt(value: unknown, importId: string): ImportReceipt {
  if (!object(value) || value.importId !== importId || value.projectId !== null && !uuid(value.projectId) || !Array.isArray(value.resources) || value.resources.length > 1000) throw corrupt();
  const aliases = new Set<string>(), ids = new Set<string>();
  for (const row of value.resources) {
    if (!object(row) || typeof row.alias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.alias) || !uuid(row.resourceId) || !uuid(row.versionId) || row.revision !== 1 || aliases.has(row.alias) || ids.has(row.resourceId) || ids.has(row.versionId)) throw corrupt();
    aliases.add(row.alias); ids.add(row.resourceId); ids.add(row.versionId);
  }
  return { importId, projectId: value.projectId as string | null, resources: value.resources.map(row => ({ alias: row.alias, resourceId: row.resourceId, versionId: row.versionId, revision: 1 })) };
}

/** Server-selected paths must still agree with the authenticated owner and immutable import identity. */
function parseEnvelope(value: unknown, ownerId: string, requestId: string, releaseId: string): ImportEnvelope {
  assertJsonData(value);
  if (!object(value) || !uuid(value.importId) || value.requestId !== requestId || value.releaseId !== releaseId || !['staging', 'committed', 'failed'].includes(String(value.state)) || !object(value.storage)) throw corrupt();
  const storage = value.storage;
  if (storage.bucket !== 'authoring-imports' || !digest(storage.sha256) || storage.path !== `${ownerId}/${value.importId}/${storage.sha256}.zip` || !Number.isSafeInteger(storage.bytes) || Number(storage.bytes) < 1 || Number(storage.bytes) > MAX_DELIVERY_BYTES) throw corrupt();
  const receipt = value.state === 'committed' ? parseImportReceipt(value.receipt, value.importId) : null;
  if (value.state !== 'committed' && value.receipt !== null) throw corrupt();
  return { importId: value.importId, requestId, releaseId, state: value.state as ImportEnvelope['state'], storage: { bucket: 'authoring-imports', path: storage.path, bytes: Number(storage.bytes), sha256: storage.sha256 }, resolution: structuredClone(value.resolution), receipt };
}

/** Account UUIDs are storage locations; the original package alias, descriptor and pinned ResourceRef remain untouched. */
export function archiveResourceContent(importId: string, resource: AuthoringImportSnapshot['resources'][number]): ArchiveResourceContent {
  return { format: 'archive_v1', importId, sourceAlias: resource.alias, reference: structuredClone(resource.reference), descriptorSha256: resource.reference.sha256, name: resource.descriptor.name, kind: resource.reference.kind, description: '' };
}

/** Prepare metadata only after full ZIP verification. Unsupported presentation data is rejected instead of discarded. */
export function privateImportPreparation(importId: string, source: AuthoringImportSnapshot): PrivateImportPreparation {
  assertId(importId);
  const name = source.workflow?.name ?? source.resources[0]?.descriptor.name ?? '가져온 도구 및 자료';
  if (!name.trim() || name.length > 120) throw new HttpError(422, 'COPY_NAME_UNSUPPORTED', '원본 이름이 현재 개인 저장소의 120자 한도를 넘습니다. 원본 이름을 임의로 변경하지 않았습니다.');
  let editor: Record<string, unknown> | undefined;
  if (source.workflow) {
    try { editor = validateImportedLayout(source.editor ?? {}, source.workflow); }
    catch { throw new HttpError(422, 'COPY_EDITOR_UNSUPPORTED', '원본의 화면 배치 형식을 현재 편집기에서 보존할 수 없습니다.'); }
  } else if (source.editor) throw new HttpError(422, 'COPY_EDITOR_UNSUPPORTED', '자료 전용 아카이브에 프로젝트 화면 배치가 포함되어 있습니다.');
  return {
    format: 'private-authoring-v1', source: structuredClone(source.source), name,
    ...(source.workflow ? { workflow: structuredClone(source.workflow), editor } : {}),
    resources: source.resources.map(resource => ({ ...structuredClone(resource), contentSha256: canonicalDigest(archiveResourceContent(importId, resource)) })),
    inventory: structuredClone(source.inventory),
  };
}

/** Storage and SQL are not one transaction. Only a verified read-back followed by atomic SQL commit becomes visible.
 * Unknown upload/commit outcomes stay staging for same-request recovery; this function never guesses success or deletes objects. */
export async function copyPublication(repository: PrivateCopyRepository, ownerId: string, requestId: string, releaseId: string, parentSignal: AbortSignal = new AbortController().signal): Promise<ImportReceipt> {
  [ownerId, requestId, releaseId].forEach(assertId); ownerId = ownerId.toLowerCase(); requestId = requestId.toLowerCase(); releaseId = releaseId.toLowerCase();
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(90000)]); signal.throwIfAborted();
  const started = parseEnvelope(await repository.begin(ownerId, requestId, releaseId, signal), ownerId, requestId, releaseId);
  // A committed receipt is recovery of an earlier transaction, not a new grant or a second copy after withdrawal.
  if (started.state === 'committed') return started.receipt!;
  if (started.state === 'failed') throw new HttpError(409, 'COPY_PREVIOUSLY_FAILED', '이 복사 요청은 종료되었습니다. 원본의 상태를 확인한 뒤 새 요청으로 다시 시도해 주세요.', { requestEnded: true });
  try {
  const initial = verifyCurrentCopyAuthority(started.resolution, releaseId);
  if (started.storage.sha256 !== initial.delivery.artifactSha256 || started.storage.bytes !== initial.delivery.artifactBytes) throw corrupt();
  const prepared = await prepareVerifiedCopySource(repository, releaseId, signal);
  if (canonicalDigest(initial) !== canonicalDigest(prepared.authority)) throw new HttpError(409, 'COPY_SOURCE_CHANGED', '복사 요청을 준비한 뒤 원본이나 이용 권한이 변경되었습니다.');
  const preparation = privateImportPreparation(started.importId, prepared.snapshot), preparationSha256 = canonicalDigest(preparation);
  if (Buffer.byteLength(JSON.stringify(preparation)) > 4 * 1024 * 1024) throw new HttpError(413, 'COPY_METADATA_TOO_LARGE', '원본의 편집 정보가 개인 저장소 한도를 넘습니다.');
  signal.throwIfAborted(); await repository.putPrivateOnce(started.storage.path, prepared.bytes, signal); signal.throwIfAborted();
  const stored = await readDeliveryBytes(await repository.openPrivateObject(started.storage.path, signal), MAX_DELIVERY_BYTES, signal);
  if (stored.length !== prepared.bytes.length || hash(stored) !== prepared.authority.delivery.artifactSha256) throw new HttpError(409, 'COPY_STORAGE_INTEGRITY', '개인 저장소에 보관된 원본이 검증한 파일과 다릅니다.');
  const staged = parseEnvelope(await repository.stage(started.importId, preparation, preparationSha256, stored.length, hash(stored), signal), ownerId, requestId, releaseId);
  if (staged.importId !== started.importId || canonicalDigest(staged.storage) !== canonicalDigest(started.storage) || canonicalDigest(staged.resolution) !== canonicalDigest(started.resolution)) throw corrupt();
  if (staged.state === 'committed') return staged.receipt!;
  if (staged.state !== 'staging') throw corrupt();
  signal.throwIfAborted();
  const committed = parseEnvelope(await repository.commit(started.importId, preparationSha256, signal), ownerId, requestId, releaseId);
  if (committed.importId !== started.importId || committed.state !== 'committed' || canonicalDigest(committed.storage) !== canonicalDigest(started.storage)) throw corrupt();
  return committed.receipt!;
  } catch (error) {
    const terminalCodes = new Set(['COPY_RIGHTS_INVALID', 'COPY_SOURCE_CHANGED', 'COPY_SOURCE_INVALID', 'COPY_NAME_UNSUPPORTED', 'COPY_EDITOR_UNSUPPORTED', 'COPY_METADATA_TOO_LARGE', 'COPY_STORAGE_INTEGRITY', 'COPY_NOT_AVAILABLE', 'COPY_IMPORT_UNAVAILABLE', 'COPY_CONFLICT', 'DELIVERY_INTEGRITY', 'DELIVERY_NOT_AVAILABLE']);
    if (!signal.aborted && error instanceof HttpError && terminalCodes.has(error.code)) {
      let ended: ImportEnvelope | undefined;
      try {
        ended = parseEnvelope(await repository.fail(started.importId, error.code, signal), ownerId, requestId, releaseId);
      } catch {
        // A concurrent commit or an uncertain failure-record response is recovered through begin/status, never erased.
      }
      if (ended?.importId === started.importId && ended.state === 'failed') throw new HttpError(error.status, error.code, error.message, { requestEnded: true });
    }
    throw error;
  }
}
