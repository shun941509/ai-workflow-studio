import "server-only";
import { canonicalDigest, verifyResources } from "@studio/package-kit";
import { authenticatedClient } from "./auth";
import { HttpError } from "./http";
import { materializeStoredResource, normalizeTextResource } from './resource-materials';
import { pinnedResourceSelection } from './private-resource-bindings';
import { materializeArchiveResources, type ArchiveResourceVersion } from './archive-resource-materials';
import { authoringServiceClient } from './authoring-service';

/** Text resources are real versioned content; unsupported executable imports remain unavailable. */
export async function createResource(body: Record<string, unknown>) {
  const content = normalizeTextResource(body);
  const { client } = await authenticatedClient();
  const { data, error } = await client.rpc("create_private_resource", { p_name: content.name, p_kind: content.kind, p_description: content.description, p_content: content, p_sha256: canonicalDigest(content) });
  if (error) throw new HttpError(503, "RESOURCE_SAVE_FAILED", "자료를 계정에 저장하지 못했습니다.");
  return data;
}

/** Every export rechecks the authenticated owner and exact immutable revision instead of trusting browser text. */
export async function loadPinnedResourceFiles(value: unknown, versionBindings: unknown = {}) {
  const { refs, bindings } = pinnedResourceSelection(value, versionBindings); const ids = Object.keys(refs);
  if (!ids.length) return { refs, files: {} as Record<string, Uint8Array>, bindings: {} as Record<string, string> };
  const { client, user } = await authenticatedClient();
  const legacyIds = ids.filter(alias => !bindings[alias]), versionIds = [...new Set(Object.values(bindings))];
  const versions: ArchiveResourceVersion[] = [];
  // Exact UUID/revision pairs avoid reading every historical body and silently losing the requested
  // old version behind a global row limit. Eight selections keep SQL URLs and JSON allocation bounded.
  for (let start = 0; start < legacyIds.length; start += 8) {
    const batch = legacyIds.slice(start, start + 8);
    const filter = batch.map(id => `and(resource_id.eq.${id},revision.eq.${refs[id]!.revision})`).join(',');
    const { data, error } = await client.from('resource_versions').select('id,resource_id,revision,content,sha256').or(filter).limit(batch.length);
    if (error) throw new HttpError(503, 'RESOURCE_STORAGE_UNAVAILABLE', '고정한 자료 버전을 읽지 못했습니다.'); versions.push(...data ?? []);
  }
  for (let start = 0; start < versionIds.length; start += 8) {
    const batch = versionIds.slice(start, start + 8);
    const { data, error } = await client.from('resource_versions').select('id,resource_id,revision,content,sha256').in('id', batch).limit(batch.length);
    if (error) throw new HttpError(503, 'RESOURCE_STORAGE_UNAVAILABLE', '선택한 자료 버전을 읽지 못했습니다.'); versions.push(...data ?? []);
  }
  const ownerIds = [...new Set(versions.map(row => row.resource_id))];
  const ownedIds = new Set<string>();
  for (let start = 0; start < ownerIds.length; start += 8) {
    const batch = ownerIds.slice(start, start + 8), owned = await client.from('resources').select('id').eq('owner_id', user.id).in('id', batch).limit(batch.length);
    if (owned.error) throw new HttpError(503, 'RESOURCE_STORAGE_UNAVAILABLE', '자료의 계정 소유권을 확인하지 못했습니다.');
    for (const row of owned.data ?? []) ownedIds.add(row.id);
  }
  const files: Record<string, Uint8Array> = Object.create(null), resolvedBindings: Record<string, string> = Object.create(null); const archives: { alias: string; reference: typeof refs[string]; version: ArchiveResourceVersion }[] = [];
  for (const [id, reference] of Object.entries(refs)) {
    const row = bindings[id] ? versions.find(version => version.id === bindings[id]) : versions.find(version => version.resource_id === id && version.revision === reference.revision);
    if (!row) throw new HttpError(409, 'RESOURCE_VERSION_MISSING', '고정한 자료 버전을 찾을 수 없습니다. 최신 버전으로 자동 교체하지 않습니다.');
    if (!ownedIds.has(row.resource_id)) throw new HttpError(404, 'RESOURCE_NOT_FOUND', '연결된 자료를 이 계정에서 찾을 수 없습니다.');
    resolvedBindings[id] = row.id;
    const content = row.content;
    if (content && typeof content === 'object' && !Array.isArray(content) && 'format' in content && content.format === 'archive_v1') { archives.push({ alias: id, reference, version: row }); continue; }
    const materialized = materializeStoredResource(row);
    if (id !== row.resource_id || canonicalDigest(materialized.reference) !== canonicalDigest(reference)) throw new HttpError(409, 'RESOURCE_REF_MISMATCH', '고정한 자료 검증 값이 실제 버전과 다릅니다. 다시 연결해 주세요.');
    Object.assign(files, materialized.files);
  }
  if (archives.length) {
    const signal = AbortSignal.timeout(60000), service = authoringServiceClient(signal);
    const archivedFiles = await materializeArchiveResources({
      async source(ownerId, importId) {
        const { data, error } = await service.from('private_imports').select('id,owner_id,state,storage_deleted_at,artifact_sha256,artifact_bytes,storage_path,resolution,preparation,preparation_sha256').eq('id', importId).eq('owner_id', ownerId).eq('state', 'committed').is('storage_deleted_at', null).maybeSingle();
        if (error || !data) throw new HttpError(409, 'ARCHIVE_RESOURCE_UNAVAILABLE', '이 계정에 보관된 원본 자료를 확인하지 못했습니다.'); return data;
      },
      async openObject(path) { const { data, error } = await service.storage.from('authoring-imports').download(path); if (error || !data) throw new HttpError(503, 'ARCHIVE_STORAGE_UNAVAILABLE', '원본 자료 파일을 읽지 못했습니다.'); return new Response(data); },
    }, user.id, archives, signal);
    for (const [path, bytes] of Object.entries(archivedFiles)) { if (Object.hasOwn(files, path)) throw new HttpError(409, 'RESOURCE_ALIAS_CONFLICT', '같은 별칭의 자료가 중복 연결되어 있습니다.'); files[path] = bytes; }
  }
  try { verifyResources(refs, new Map(Object.entries(files))); } catch { throw new HttpError(409, 'RESOURCE_DEPENDENCY_INVALID', '고정된 자료와 전이 의존성을 모두 연결해야 합니다.'); }
  return { refs, files, bindings: resolvedBindings };
}
