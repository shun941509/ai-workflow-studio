import "server-only";
import { canonicalDigest } from "@studio/package-kit";
import { authenticatedClient } from "./auth";
import { HttpError } from "./http";
import { materializeStoredResource, normalizeTextResource, validatePinnedTextRefs } from './resource-materials';
import type { PrivateTextResource } from '../features/resources/types';

/** Private resource metadata is loaded through the same user-scoped RLS client as projects. */
export async function listResources() {
  const { client, user } = await authenticatedClient();
  const { data, error } = await client.from("resources").select("id,name,kind,description,created_at,resource_versions(revision,content,sha256)").eq("owner_id", user.id).order("created_at", { ascending: false }).limit(100);
  if (error) throw new HttpError(503, "RESOURCE_STORAGE_UNAVAILABLE", "자료 저장소에 연결하지 못했습니다.");
  return (data ?? []).map((resource) => ({ ...resource, resource_versions: resource.resource_versions.map((version) => {
    const materialized = materializeStoredResource({ resource_id: resource.id, ...version });
    return { revision: version.revision, content: materialized.content, reference: materialized.reference };
  }).sort((a, b) => b.revision - a.revision) })) as PrivateTextResource[];
}

/** Text resources are real versioned content; unsupported executable imports remain unavailable. */
export async function createResource(body: Record<string, unknown>) {
  const content = normalizeTextResource(body);
  const { client } = await authenticatedClient();
  const { data, error } = await client.rpc("create_private_resource", { p_name: content.name, p_kind: content.kind, p_description: content.description, p_content: content, p_sha256: canonicalDigest(content) });
  if (error) throw new HttpError(503, "RESOURCE_SAVE_FAILED", "자료를 계정에 저장하지 못했습니다.");
  return data;
}

/** Every export rechecks the authenticated owner and exact immutable revision instead of trusting browser text. */
export async function loadPinnedResourceFiles(value: unknown) {
  const refs = validatePinnedTextRefs(value); const ids = Object.keys(refs);
  if (!ids.length) return { refs, files: {} as Record<string, Uint8Array> };
  const { client, user } = await authenticatedClient();
  const [owned, versions] = await Promise.all([
    client.from('resources').select('id').eq('owner_id', user.id).in('id', ids),
    client.from('resource_versions').select('resource_id,revision,content,sha256').in('resource_id', ids),
  ]);
  if (owned.error || versions.error) throw new HttpError(503, 'RESOURCE_STORAGE_UNAVAILABLE', '연결한 자료를 확인하지 못했습니다.');
  const ownedIds = new Set((owned.data ?? []).map((row) => row.id));
  const files: Record<string, Uint8Array> = {};
  for (const [id, reference] of Object.entries(refs)) {
    if (!ownedIds.has(id)) throw new HttpError(404, 'RESOURCE_NOT_FOUND', '연결된 자료를 이 계정에서 찾을 수 없습니다.');
    const row = versions.data?.find((version) => version.resource_id === id && version.revision === reference.revision);
    if (!row) throw new HttpError(409, 'RESOURCE_VERSION_MISSING', '고정한 자료 버전을 찾을 수 없습니다. 최신 버전으로 자동 교체하지 않습니다.');
    const materialized = materializeStoredResource(row);
    if (canonicalDigest(materialized.reference) !== canonicalDigest(reference)) throw new HttpError(409, 'RESOURCE_REF_MISMATCH', '고정한 자료 검증 값이 실제 버전과 다릅니다. 다시 연결해 주세요.');
    Object.assign(files, materialized.files);
  }
  return { refs, files };
}
