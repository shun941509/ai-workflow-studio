import { parseDocument } from 'yaml';
import { assertJsonData } from '@studio/spec';
import { PackageError } from './errors.js';
import { validatePackagePath } from './archive/safe-path.js';

export interface SkillMetadata { name: string; description: string; license?: string; compatibility?: string; metadata?: Record<string, string> }
/** Parse bounded standard metadata; host permission pre-approval and unknown extensions are not imported implicitly. */
export function readSkillMetadata(bytes: Uint8Array): SkillMetadata {
  const fail = (): never => { throw new PackageError('SKILL_METADATA_INVALID', 'SKILL.md의 이름·설명·메타데이터를 확인하세요. 이름은 소문자·숫자·하이픈으로 구성하며 권한 사전 승인 필드는 지원하지 않습니다.'); };
  if (bytes.length > 256 * 1024) return fail();
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail(); }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match || match[1]!.length > 16384 || !text.slice(match[0].length).trim()) return fail();
  let value: unknown;
  try {
    const document = parseDocument(match[1]!, { schema: 'failsafe', strict: true, uniqueKeys: true });
    if (document.errors.length || document.warnings.length) return fail();
    value = document.toJS({ maxAliasCount: 0 });
    assertJsonData(value);
  } catch { return fail(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['name', 'description', 'license', 'compatibility', 'metadata'].includes(key))) return fail();
  if (typeof record.name !== 'string' || record.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.name) || typeof record.description !== 'string' || !record.description.trim() || record.description.length > 1024) return fail();
  for (const [key, max] of [['license', 1024], ['compatibility', 500]] as const) if (record[key] !== undefined && (typeof record[key] !== 'string' || !record[key].trim() || record[key].length > max)) return fail();
  if (record.metadata !== undefined && (!record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata) || Object.keys(record.metadata).length > 32 || Object.entries(record.metadata).some(([key, value]) => key.length > 100 || typeof value !== 'string' || value.length > 1024))) return fail();
  validatePackagePath(record.name);
  return structuredClone(record) as unknown as SkillMetadata;
}
