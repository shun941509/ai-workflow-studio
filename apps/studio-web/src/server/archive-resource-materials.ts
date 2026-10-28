import 'server-only';
import { createHash, createPublicKey } from 'node:crypto';
import { assertJsonData, type ResourceRef } from '@studio/spec';
import { canonicalDigest, prepareAuthoringImport } from '@studio/package-kit';
import { archiveResourceContent, type ArchiveResourceContent } from './publication-copy';
import { MAX_DELIVERY_BYTES, readDeliveryBytes } from './publication-delivery';
import { HttpError, assertId } from './http';

export interface ArchiveResourceVersion { id: string; resource_id: string; revision: number; content: unknown; sha256: string }
export interface ArchiveMaterialRepository {
  /** The service query must include owner_id, committed state and storage_deleted_at is null. */
  source(ownerId: string, importId: string, signal: AbortSignal): Promise<unknown>;
  openObject(path: string, signal: AbortSignal): Promise<Response>;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const invalid = () => new HttpError(409, 'ARCHIVE_RESOURCE_INTEGRITY', '보관된 자료의 원본과 고정 버전이 일치하지 않습니다.');

/** Resource content hashes pin archive identity and metadata; they are distinct from the original descriptor-byte hash. */
export function parseArchiveResourceVersion(row: ArchiveResourceVersion): ArchiveResourceContent {
  try {
    assertId(row.id); assertId(row.resource_id); assertJsonData(row.content);
    if (row.revision !== 1 || !object(row.content) || !digest(row.sha256) || canonicalDigest(row.content) !== row.sha256) throw invalid();
    const content = row.content;
    if (Object.keys(content).sort().join(',') !== ['format', 'importId', 'sourceAlias', 'reference', 'descriptorSha256', 'name', 'kind', 'description'].sort().join(',') || content.format !== 'archive_v1' || typeof content.importId !== 'string' || typeof content.sourceAlias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(content.sourceAlias) || !object(content.reference) || !digest(content.descriptorSha256) || typeof content.name !== 'string' || !content.name.trim() || content.name.length > 200 || !['instruction', 'document', 'skill', 'mcp'].includes(String(content.kind)) || content.description !== '') throw invalid();
    assertId(content.importId);
    const reference = content.reference;
    if (Object.keys(reference).sort().join(',') !== 'id,kind,revision,sha256' || typeof reference.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(reference.id) || reference.kind !== content.kind || !Number.isSafeInteger(reference.revision) || Number(reference.revision) < 1 || reference.sha256 !== content.descriptorSha256) throw invalid();
    return structuredClone(content) as unknown as ArchiveResourceContent;
  } catch { throw invalid(); }
}

/** A committed private copy retains the trust pinned when it was legally copied. Re-export is not a new public release.
 * This path does not turn a later grant expiration into permission for new copies or claim to recall received bytes. */
export async function materializeArchiveResources(repository: ArchiveMaterialRepository, ownerId: string, selections: { alias: string; reference: ResourceRef; version: ArchiveResourceVersion }[], parentSignal: AbortSignal = new AbortController().signal) {
  assertId(ownerId); const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(60000)]);
  if (selections.length > 1000) throw invalid();
  assertJsonData(selections); selections = structuredClone(selections);
  const files: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  const groups = new Map<string, { selection: typeof selections[number]; content: ArchiveResourceContent }[]>();
  let archiveBytes = 0, materialBytes = 0, expandedBytes = 0, expandedFiles = 0;
  for (const selection of selections) {
    signal.throwIfAborted(); const content = parseArchiveResourceVersion(selection.version);
    if (selection.alias !== content.sourceAlias || canonicalDigest(selection.reference) !== canonicalDigest(content.reference)) throw invalid();
    const group = groups.get(content.importId) ?? []; group.push({ selection, content }); groups.set(content.importId, group);
  }
  // Process each archive once and discard its unselected decoded payloads before opening the next source.
  // Both selected bytes and all inspected resource bytes/files count toward the aggregate bound.
  for (const [importId, group] of groups) {
      signal.throwIfAborted();
      const received = await repository.source(ownerId, importId, signal); assertJsonData(received); const raw: unknown = structuredClone(received);
      if (!object(raw) || raw.id !== importId || raw.owner_id !== ownerId || raw.state !== 'committed' || raw.storage_deleted_at !== null || !digest(raw.artifact_sha256) || !Number.isSafeInteger(raw.artifact_bytes) || Number(raw.artifact_bytes) < 1 || Number(raw.artifact_bytes) > MAX_DELIVERY_BYTES || raw.storage_path !== `${ownerId}/${importId}/${raw.artifact_sha256}.zip` || !object(raw.resolution) || !object(raw.resolution.delivery) || !object(raw.preparation) || !digest(raw.preparation_sha256) || canonicalDigest(raw.preparation) !== raw.preparation_sha256) throw invalid();
      const delivery = raw.resolution.delivery;
      if (delivery.artifactSha256 !== raw.artifact_sha256 || delivery.artifactBytes !== raw.artifact_bytes || !digest(delivery.manifestSha256) || !object(delivery.signingKey) || !object(raw.preparation.source)) throw invalid();
      const key = delivery.signingKey;
      if (typeof key.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(key.id) || typeof key.publicKey !== 'string' || key.publicKey.length > 4096 || !digest(key.sha256)) throw invalid();
      try { const parsed = createPublicKey(key.publicKey); if (parsed.asymmetricKeyType !== 'ed25519' || hash(parsed.export({ type: 'spki', format: 'der' })) !== key.sha256) throw invalid(); } catch { throw invalid(); }
      const bytes = await readDeliveryBytes(await repository.openObject(raw.storage_path, signal), MAX_DELIVERY_BYTES, signal);
      archiveBytes += bytes.length;
      if (archiveBytes > 64 * 1024 * 1024 || bytes.length !== raw.artifact_bytes || hash(bytes) !== raw.artifact_sha256) throw invalid();
      let snapshot: Awaited<ReturnType<typeof prepareAuthoringImport>>;
      try { snapshot = await prepareAuthoringImport(bytes, { requireSignature: true, trustStore: { [key.id]: key.publicKey } }); } catch { throw invalid(); }
      if (snapshot.source.manifestSha256 !== delivery.manifestSha256 || canonicalDigest(snapshot.source) !== canonicalDigest(raw.preparation.source)) throw invalid();
      expandedBytes += snapshot.inventory.bytes; expandedFiles += snapshot.inventory.fileCount;
      if (expandedBytes > 64 * 1024 * 1024 || expandedFiles > 2000) throw new HttpError(413, 'ARCHIVE_AGGREGATE_LIMIT', '연결한 원본 아카이브 전체의 자료가 64 MiB 또는 2,000파일 한도를 넘습니다.');
    for (const { selection, content } of group) {
    const resource = snapshot.resources.find(candidate => candidate.alias === content.sourceAlias);
    if (!resource || canonicalDigest(archiveResourceContent(content.importId, resource)) !== selection.version.sha256) throw invalid();
    const prefix = `resources/${selection.alias}/`;
    for (const [path, bytes] of Object.entries(snapshot.resourceFiles)) if (path.startsWith(prefix)) {
      if (Object.hasOwn(files, path)) throw new HttpError(409, 'RESOURCE_ALIAS_CONFLICT', '같은 이름으로 서로 다른 자료가 연결되어 있습니다.');
      materialBytes += bytes.length; if (materialBytes > 64 * 1024 * 1024 || Object.keys(files).length >= 2000) throw invalid();
      files[path] = new Uint8Array(bytes);
    }
    }
  }
  signal.throwIfAborted(); return files;
}
