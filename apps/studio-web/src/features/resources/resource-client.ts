import type { PrivateResourceDetail, PrivateResourceSummary } from './types';

export type ResourcePage = { resources: PrivateResourceSummary[]; nextCursor: string | null };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const kinds = ['instruction', 'document', 'skill', 'mcp'];
/** Validate the rendered shape before the preview reads it. Archive contents remain escaped metadata only. */
function previewContent(value: unknown): boolean {
  if (!object(value) || typeof value.name !== 'string' || typeof value.description !== 'string' || !kinds.includes(String(value.kind))) return false;
  if (value.format === 'text') return ['instruction', 'document'].includes(String(value.kind)) && typeof value.text === 'string' && value.text.length <= 262144;
  return value.format === 'archive_v1' && object(value.license) && typeof value.license.id === 'string' && typeof value.license.path === 'string' && Array.isArray(value.files) && value.files.length <= 1000 && value.files.every(file => object(file) && typeof file.path === 'string' && Number.isSafeInteger(file.bytes) && Number(file.bytes) >= 0 && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256));
}

/** Collection responses are metadata only. The browser never constructs a reference from an account ID. */
export async function readResourcePage(cursor?: string, signal?: AbortSignal): Promise<ResourcePage> {
  const response = await fetch(`/api/resources${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { cache: 'no-store', signal }); const value: unknown = await response.json();
  if (!response.ok) throw new Error(object(value) && object(value.error) && typeof value.error.message === 'string' ? value.error.message : '자료 목록을 불러오지 못했습니다.');
  if (!object(value) || !Array.isArray(value.resources) || value.resources.length > 40 || !(value.nextCursor === null || typeof value.nextCursor === 'string' && /^[A-Za-z0-9_-]{1,300}$/.test(value.nextCursor))) throw new Error('자료 목록의 페이지 정보를 확인해야 합니다.');
  for (const item of value.resources) if (!object(item) || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.description !== 'string' || !['instruction', 'document', 'skill', 'mcp'].includes(String(item.kind)) || typeof item.versionsTruncated !== 'boolean' || !Array.isArray(item.resource_versions) || item.resource_versions.length > 100 || item.resource_versions.some(version => !object(version) || typeof version.id !== 'string' || !Number.isSafeInteger(version.revision) || !object(version.content) || !['text', 'archive_v1'].includes(String(version.content.format)) || typeof version.content.name !== 'string' || typeof version.content.description !== 'string')) throw new Error('자료의 버전 목록을 확인해야 합니다.');
  return value as ResourcePage;
}

/** A detail response belongs to one explicitly chosen immutable version, never whichever request finishes last. */
export async function readResourceDetail(resourceId: string, versionId: string, signal?: AbortSignal): Promise<PrivateResourceDetail> {
  const response = await fetch(`/api/resources/${encodeURIComponent(resourceId)}?versionId=${encodeURIComponent(versionId)}`, { cache: 'no-store', signal }); const value: unknown = await response.json();
  if (!response.ok) throw new Error(object(value) && object(value.error) && typeof value.error.message === 'string' ? value.error.message : '선택한 자료 버전을 읽지 못했습니다.');
  if (!object(value) || !object(value.resource) || value.resource.id !== resourceId || !object(value.version) || value.version.id !== versionId || !previewContent(value.version.content) || !object(value.version.reference) || !object(value.refs) || !object(value.resourceBindings) || !object(value.resourceDependencies) || !(value.origin === null || object(value.origin) && object(value.origin.source) && typeof value.origin.copied_at === 'string')) throw new Error('선택한 자료와 응답의 고정 버전이 다르거나 내용을 확인할 수 없습니다.');
  return value as unknown as PrivateResourceDetail;
}
