import 'server-only';
import { canonicalDigest, createTextResource } from '@studio/package-kit';
import type { ResourceRef } from '@studio/spec';
import type { TextResourceContent } from '../features/resources/types';
import { assertId, HttpError } from './http';

/** Immutable version content pins the visible metadata as well as the actual text. */
export function normalizeTextResource(body: Record<string, unknown>): TextResourceContent {
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120) throw new HttpError(422, 'NAME_INVALID', '자료 이름을 1~120자로 입력해 주세요.');
  if (body.kind !== 'instruction' && body.kind !== 'document') throw new HttpError(422, 'RESOURCE_KIND_UNAVAILABLE', '현재는 작업 지침과 텍스트 문서를 저장할 수 있습니다.');
  if (typeof body.text !== 'string' || !body.text.trim() || new TextEncoder().encode(body.text).length > 256 * 1024) throw new HttpError(422, 'CONTENT_INVALID', '자료 본문은 비어 있지 않은 256 KiB 이하의 텍스트여야 합니다.');
  if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 2000)) throw new HttpError(422, 'DESCRIPTION_INVALID', '설명을 2,000자 이내로 입력해 주세요.');
  return { format: 'text', name: body.name.trim(), kind: body.kind, description: typeof body.description === 'string' ? body.description : '', text: body.text };
}

/** DB hashes attest canonical content; the ResourceRef separately hashes resource.json's original bytes. */
export function materializeStoredResource(row: { resource_id: string; revision: number; content: unknown; sha256: string }) {
  assertId(row.resource_id);
  if (!Number.isSafeInteger(row.revision) || row.revision < 1 || !row.content || typeof row.content !== 'object' || Array.isArray(row.content)) throw new HttpError(409, 'RESOURCE_INTEGRITY', '저장된 자료 버전을 확인해야 합니다.');
  const raw = row.content as Record<string, unknown>;
  if (raw.format !== 'text' || Object.keys(raw).some((key) => !['format', 'name', 'kind', 'description', 'text'].includes(key)) || canonicalDigest(row.content) !== row.sha256) throw new HttpError(409, 'RESOURCE_INTEGRITY', '자료 내용이 저장된 검증 값과 다릅니다.');
  const content = normalizeTextResource(raw);
  // Reject silently normalizing old or changed content after its version was pinned.
  if (canonicalDigest(content) !== row.sha256) throw new HttpError(409, 'RESOURCE_INTEGRITY', '자료 메타데이터가 고정된 버전과 다릅니다.');
  return { content, ...createTextResource({ id: row.resource_id, revision: row.revision, name: content.name, kind: content.kind, text: content.text }) };
}

/** UUID aliases bind the browser selection to the same private resource identity on the server. */
export function validatePinnedTextRefs(value: unknown): Record<string, ResourceRef> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100) throw new HttpError(422, 'RESOURCE_REFS_INVALID', '연결된 자료 목록을 확인해 주세요.');
  const result: Record<string, ResourceRef> = {};
  for (const [alias, item] of Object.entries(value)) {
    assertId(alias);
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(422, 'RESOURCE_REF_INVALID', '자료 버전 정보를 확인해 주세요.');
    const ref = item as Record<string, unknown>;
    if (Object.keys(ref).some((key) => !['id', 'revision', 'kind', 'sha256'].includes(key)) || ref.id !== alias || !Number.isSafeInteger(ref.revision) || Number(ref.revision) < 1 || ref.kind !== 'instruction' && ref.kind !== 'document' || typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw new HttpError(422, 'RESOURCE_REF_INVALID', '고정한 자료 ID·종류·버전·검증 값을 확인해 주세요.');
    result[alias] = { id: alias, revision: Number(ref.revision), kind: ref.kind, sha256: ref.sha256 };
  }
  return result;
}
