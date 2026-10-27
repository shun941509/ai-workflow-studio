import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import { createSchemaValidator, parseStrictJson, type ResourceRef } from '@studio/spec';
import schema from '../../spec/schemas/resource-descriptor.schema.json' with { type: 'json' };
import referenceSchema from '../../spec/schemas/resource-ref.schema.json' with { type: 'json' };
import type { ResourceDescriptor } from './generated/resource.js';
import { PackageError } from './errors.js';
import { pathKey, validatePackagePath } from './archive/safe-path.js';
import { readSkillMetadata } from './skills.js';

const validator = createSchemaValidator();
validator.addSchema(referenceSchema, 'resource-ref.schema.json');
const validate = validator.compile<ResourceDescriptor>(schema);
const validateReference = validator.compile<ResourceRef>(referenceSchema);
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
export type { ResourceDescriptor };

/** Materialize a complete, portable text revision with explicit private-use terms and no hidden files. */
export function createTextResource(input: { id: string; revision: number; name: string; kind: 'instruction' | 'document'; text: string }) {
  const encode = (value: string) => new TextEncoder().encode(value);
  const entrypoint = input.kind === 'instruction' ? 'instructions.md' : 'document.txt';
  const payloads = new Map<string, Uint8Array>([
    [entrypoint, encode(input.text)],
    ['LICENSE.txt', encode('LicenseRef-Proprietary\n개인 작업을 위한 자료입니다. 공개 재배포 권한을 부여하지 않습니다. 별도 허락 없이 다른 사용자에게 배포하지 마세요.\n')],
  ]);
  if (!input.name.trim() || !input.text.trim() || payloads.get(entrypoint)!.length > 256 * 1024) throw new PackageError('RESOURCE_TEXT_INVALID', '자료 이름과 256 KiB 이하의 본문이 필요합니다.');
  const descriptor: ResourceDescriptor = {
    schemaVersion: '1.0.0', id: input.id, revision: input.revision, name: input.name, kind: input.kind,
    entrypoint, license: { id: 'LicenseRef-Proprietary', path: 'LICENSE.txt' }, dependencies: {}, requiredConnections: [],
    files: [...payloads].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) as ResourceDescriptor['files'],
  };
  if (!validate(descriptor)) throw new PackageError('RESOURCE_INVALID', '자료 ID·버전·종류를 확인하세요.');
  const definition = encode(JSON.stringify(descriptor, null, 2) + '\n');
  const reference: ResourceRef = { kind: input.kind, id: input.id, revision: input.revision, sha256: hash(definition) };
  payloads.set('resource.json', definition);
  return { reference, descriptor, files: Object.fromEntries([...payloads].map(([path, bytes]) => [`resources/${input.id}/${path}`, bytes])) };
}

/** A package inventory alone cannot prove that a pinned ResourceRef denotes the included material. */
export function verifyResources(refs: Record<string, ResourceRef | undefined>, files: ReadonlyMap<string, Uint8Array>): Map<string, ResourceDescriptor> {
  const result = new Map<string, ResourceDescriptor>();
  const recognized = new Set<string>();
  for (const [alias, reference] of Object.entries(refs)) {
    if (!validateReference(reference)) throw new PackageError('RESOURCE_REFERENCE', '자료 참조가 규격에 맞지 않습니다.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(alias)) throw new PackageError('RESOURCE_ALIAS', '자료 별칭이 올바르지 않습니다.');
    const prefix = `resources/${alias}/`, descriptorPath = prefix + 'resource.json';
    const bytes = files.get(descriptorPath);
    if (!bytes || hash(bytes) !== reference.sha256) throw new PackageError('RESOURCE_INTEGRITY', `자료 정의가 고정한 해시와 다릅니다: ${alias}`);
    const value = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!validate(value)) throw new PackageError('RESOURCE_INVALID', `자료 정의 규격 오류: ${alias}`);
    if (value.id !== reference.id || value.kind !== reference.kind || value.revision !== reference.revision) throw new PackageError('RESOURCE_IDENTITY', `자료의 ID·종류·버전이 다릅니다: ${alias}`);
    recognized.add(descriptorPath);
    const names = new Set<string>();
    for (const item of value.files) {
      validatePackagePath(item.path);
      const key = pathKey(item.path), path = prefix + item.path;
      if (key === 'resource.json' || names.has(key)) throw new PackageError('RESOURCE_INVALID', '자료 목록에 중복 또는 자기 참조가 있습니다.');
      names.add(key);
      const payload = files.get(path);
      if (!payload || payload.length !== item.bytes || hash(payload) !== item.sha256) throw new PackageError('RESOURCE_INTEGRITY', `자료 내용이 다릅니다: ${path}`);
      recognized.add(path);
    }
    validatePackagePath(value.entrypoint); validatePackagePath(value.license.path);
    if (!files.has(prefix + value.entrypoint) || !names.has(pathKey(value.entrypoint)) || !names.has(pathKey(value.license.path))) throw new PackageError('RESOURCE_INCOMPLETE', `자료 본문 또는 이용 조건이 없습니다: ${alias}`);
    if (value.kind === 'skill' && value.entrypoint !== 'SKILL.md') throw new PackageError('SKILL_ENTRYPOINT', 'Skill 루트의 진입 파일은 SKILL.md여야 합니다.');
    if (value.kind === 'skill') readSkillMetadata(files.get(prefix + value.entrypoint)!);
    for (const [dependency, pinned] of Object.entries(value.dependencies)) {
      if (!refs[dependency] || canonicalize(refs[dependency]) !== canonicalize(pinned)) throw new PackageError('RESOURCE_DEPENDENCY', `고정 자료 의존성을 찾을 수 없습니다: ${dependency}`);
    }
    result.set(alias, value);
  }
  for (const path of files.keys()) if (path.startsWith('resources/') && !recognized.has(path)) throw new PackageError('RESOURCE_UNLISTED', `자료 정의에 없는 파일입니다: ${path}`);
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(alias: string): void {
    if (visiting.has(alias)) throw new PackageError('RESOURCE_CYCLE', '자료 의존성에 순환이 있습니다.');
    if (visited.has(alias)) return;
    visiting.add(alias);
    for (const dependency of Object.keys(result.get(alias)!.dependencies)) visit(dependency);
    visiting.delete(alias); visited.add(alias);
  }
  for (const alias of result.keys()) visit(alias);
  return result;
}
