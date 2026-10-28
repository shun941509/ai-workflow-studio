import 'server-only';
import { assertJsonData, type ResourceRef } from '@studio/spec';
import { assertId, HttpError } from './http';

const invalid = () => new HttpError(422, 'RESOURCE_REFS_INVALID', '고정 자료와 계정의 자료 버전 연결을 확인해 주세요.');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Package aliases are independent from account UUIDs; all nonlegacy selections carry an explicit owned version binding. */
export function pinnedResourceSelection(value: unknown, bindings: unknown = {}) {
  try { assertJsonData(value); assertJsonData(bindings); } catch { throw invalid(); }
  if (!object(value) || !object(bindings) || Object.keys(value).length > 1000 || Object.keys(bindings).length > 1000) throw invalid();
  const refs: Record<string, ResourceRef> = Object.create(null), versions: Record<string, string> = Object.create(null);
  for (const [alias, raw] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(alias) || !object(raw) || Object.keys(raw).sort().join(',') !== 'id,kind,revision,sha256' || typeof raw.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.id) || !['instruction', 'document', 'skill', 'mcp'].includes(String(raw.kind)) || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1 || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)) throw invalid();
    refs[alias] = structuredClone(raw) as unknown as ResourceRef;
    if (Object.hasOwn(bindings, alias)) {
      if (typeof bindings[alias] !== 'string') throw invalid(); assertId(bindings[alias]); versions[alias] = bindings[alias].toLowerCase();
    } else {
      // Existing text drafts remain compatible. An opaque archive alias cannot be guessed into an account identity.
      assertId(alias); if (raw.id !== alias || !['instruction', 'document'].includes(String(raw.kind))) throw invalid();
    }
  }
  if (Object.keys(bindings).some(alias => !Object.hasOwn(refs, alias))) throw invalid();
  return { refs, bindings: versions };
}
