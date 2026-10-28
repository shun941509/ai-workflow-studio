import 'server-only';
import { parseStrictJson, type ResourceRef } from '@studio/spec';
import { canonicalDigest } from '@studio/package-kit';
import { authenticatedClient } from './auth';
import { assertId, HttpError } from './http';
import { materializeStoredResource } from './resource-materials';
import { parseArchiveResourceVersion } from './archive-resource-materials';
import { loadPinnedResourceFiles } from './resources';
import type { PrivateResourceDetail, PrivateResourceSummary, ResourceVersionSummary } from '../features/resources/types';

const invalid = () => new HttpError(422, 'RESOURCE_CURSOR_INVALID', '자료 목록의 다음 페이지 주소를 확인해 주세요.');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Stable time+UUID pagination retains database microseconds and admits no PostgREST filter syntax from callers. */
export function resourceCursor(value: string | null): { createdAt: string; id: string } | null {
  if (value === null) return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,300}$/.test(value)) throw invalid();
    const bytes = Buffer.from(value, 'base64url'); if (bytes.toString('base64url') !== value) throw invalid();
    const raw = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(raw) || Object.keys(raw).sort().join(',') !== 'createdAt,id' || typeof raw.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw.createdAt) || !Number.isFinite(Date.parse(raw.createdAt)) || typeof raw.id !== 'string') throw invalid();
    assertId(raw.id); return { createdAt: raw.createdAt, id: raw.id.toLowerCase() };
  } catch { throw invalid(); }
}

/** List only immutable metadata. Large document text, code and archive bytes are not loaded with every card. */
export async function listResourcePage(cursor: string | null) {
  const after = resourceCursor(cursor), { client, user } = await authenticatedClient({ maxTotalBytes: 16 * 1024 * 1024 });
  let query = client.from('resources').select('id,name,kind,description,created_at').eq('owner_id', user.id).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(41);
  if (after) query = query.or(`created_at.lt.${after.createdAt},and(created_at.eq.${after.createdAt},id.lt.${after.id})`);
  const { data, error } = await query;
  if (error) throw new HttpError(503, 'RESOURCE_STORAGE_UNAVAILABLE', '자료 목록을 불러오지 못했습니다.');
  const page = (data ?? []).slice(0, 40);
  const versionPages = new Map<string, { versions: ResourceVersionSummary[]; truncated: boolean }>();
  // Parent pagination does not bound nested versions. Fetch two parents at a time, explicitly
  // limit each embedded relation and use the 101st version only to disclose truncation.
  for (let start = 0; start < page.length; start += 2) {
    const batch = page.slice(start, start + 2);
    const response = await client.from('resources').select('id,resource_versions(id,revision,format:content->>format,name:content->>name,kind:content->>kind,description:content->>description)')
      .eq('owner_id', user.id).in('id', batch.map(item => item.id)).order('revision', { ascending: false, referencedTable: 'resource_versions' })
      .limit(101, { referencedTable: 'resource_versions' }).limit(batch.length);
    if (response.error) throw new HttpError(503, 'RESOURCE_STORAGE_UNAVAILABLE', '자료 버전 목록을 불러오지 못했습니다.');
    for (const item of response.data ?? []) {
      const versions = item.resource_versions.slice(0, 100).map(version => {
        if (!['text', 'archive_v1'].includes(version.format) || typeof version.name !== 'string' || version.name.length > 200
          || !['instruction', 'document', 'skill', 'mcp'].includes(version.kind) || typeof version.description !== 'string' || version.description.length > 2000
          || !Number.isSafeInteger(version.revision) || version.revision < 1) throw new HttpError(409, 'RESOURCE_METADATA_INVALID', '저장된 자료 버전 정보를 확인해야 합니다.');
        return { id: version.id, revision: version.revision, content: { format: version.format, name: version.name, kind: version.kind, description: version.description } } as ResourceVersionSummary;
      });
      versionPages.set(item.id, { versions, truncated: item.resource_versions.length > 100 });
    }
  }
  const resources: PrivateResourceSummary[] = page.map(item => ({ id: item.id, name: item.name, kind: item.kind, description: item.description,
    resource_versions: versionPages.get(item.id)?.versions ?? [], versionsTruncated: versionPages.get(item.id)?.truncated ?? false,
  }));
  const last = page.at(-1);
  return { resources, nextCursor: (data?.length ?? 0) > 40 && last ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString('base64url') : null };
}

/** A chosen version returns its entire pinned dependency selection; aliases are never guessed from account IDs. */
export async function getResourceDetail(resourceId: string, versionId: string): Promise<PrivateResourceDetail> {
  assertId(resourceId); assertId(versionId); const { client, user } = await authenticatedClient();
  const [resource, version, origin] = await Promise.all([
    client.from('resources').select('id,name,kind,description').eq('id', resourceId).eq('owner_id', user.id).maybeSingle(),
    client.from('resource_versions').select('id,resource_id,revision,content,sha256').eq('id', versionId).eq('resource_id', resourceId).maybeSingle(),
    client.from('resource_origins').select('source,copied_at').eq('version_id', versionId).maybeSingle(),
  ]);
  if (resource.error || version.error || origin.error) throw new HttpError(503, 'RESOURCE_STORAGE_UNAVAILABLE', '자료 버전을 읽지 못했습니다.');
  if (!resource.data || !version.data) throw new HttpError(404, 'RESOURCE_NOT_FOUND', '이 계정에서 선택한 자료 버전을 찾을 수 없습니다.');
  const row = version.data;
  if (row.content?.format !== 'archive_v1') {
    const material = materializeStoredResource(row);
    return { resource: resource.data, version: { id: row.id, revision: row.revision, content: material.content, reference: material.reference }, refs: { [resourceId]: material.reference }, resourceBindings: { [resourceId]: row.id }, resourceDependencies: { [resourceId]: [] }, origin: origin.data };
  }
  const content = parseArchiveResourceVersion(row);
  const { data: siblings, error } = await client.from('resource_archive_versions').select('version_id,source_alias,reference,descriptor').eq('import_id', content.importId).limit(1000);
  if (error) throw new HttpError(503, 'RESOURCE_STORAGE_UNAVAILABLE', '자료의 고정 의존성을 읽지 못했습니다.');
  const root = siblings?.find(item => item.version_id === row.id && item.source_alias === content.sourceAlias);
  if (!root) throw new HttpError(409, 'RESOURCE_DEPENDENCY_INVALID', '원본 자료의 고정 연결을 찾을 수 없습니다.');
  const refs: Record<string, ResourceRef> = Object.create(null), bindings: Record<string, string> = Object.create(null), dependencies: Record<string, string[]> = Object.create(null), visiting = new Set<string>();
  const visit = (alias: string, expected: ResourceRef) => {
    if (visiting.has(alias)) throw new HttpError(409, 'RESOURCE_DEPENDENCY_INVALID', '자료 의존성이 순환합니다.');
    if (Object.hasOwn(refs, alias)) { if (canonicalDigest(refs[alias]) !== canonicalDigest(expected)) throw new HttpError(409, 'RESOURCE_DEPENDENCY_INVALID', '같은 자료의 버전이 충돌합니다.'); return; }
    const item = siblings?.find(candidate => candidate.source_alias === alias);
    if (!item || canonicalDigest(item.reference) !== canonicalDigest(expected) || !object(item.descriptor) || !object(item.descriptor.dependencies)) throw new HttpError(409, 'RESOURCE_DEPENDENCY_INVALID', '자료의 고정 의존성이 누락되었습니다.');
    visiting.add(alias); refs[alias] = expected; bindings[alias] = item.version_id;
    dependencies[alias] = Object.keys(item.descriptor.dependencies);
    for (const [dependency, reference] of Object.entries(item.descriptor.dependencies)) visit(dependency, reference as ResourceRef);
    visiting.delete(alias);
  };
  visit(content.sourceAlias, content.reference);
  // Revalidate bytes and ownership before displaying verified details or handing an attachment selection to the editor.
  await loadPinnedResourceFiles(refs, bindings);
  return { resource: resource.data, version: { id: row.id, revision: row.revision, reference: content.reference, content: { format: 'archive_v1', name: content.name, kind: content.kind, description: '', license: root.descriptor.license, files: root.descriptor.files } }, refs, resourceBindings: bindings, resourceDependencies: dependencies, origin: origin.data };
}
