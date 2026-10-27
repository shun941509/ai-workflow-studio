import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { canonicalize } from 'json-canonicalize';
import { deflateSync, zipSync, type Zippable } from 'fflate';
import { createSchemaValidator, parseStrictJson, validateWorkflowShape, type Workflow, type ResourceRef } from '@studio/spec';
import { analyzeWorkflow, collectRequirements } from '@studio/workflow-core';
import manifestSchema from '../../spec/schemas/package-manifest.schema.json' with { type: 'json' };
import runtimeSchema from '../../spec/schemas/runtime-lock.schema.json' with { type: 'json' };
import type { RuntimeRequirementsLock } from './generated/runtime-lock.js';
import type { PackageManifest } from './generated/manifest.js';
import { PackageError } from './errors.js';
import { assertProductionFile, pathKey, validatePackagePath } from './archive/safe-path.js';
import { DEFAULT_LIMITS, readZip, type ArchiveLimits } from './archive/read-zip.js';
import { createHostFiles, type TargetHost } from './adapters/hosts.js';
import { verifyResources } from './resources.js';
import { readSkillMetadata } from './skills.js';
export { readSkillMetadata, type SkillMetadata } from './skills.js';
export { verifyResources, createTextResource, type ResourceDescriptor } from './resources.js';

export type { PackageManifest, TargetHost, ArchiveLimits };
export { PackageError, createHostFiles, DEFAULT_LIMITS };
const encode = (text: string) => new TextEncoder().encode(text);
const jsonBytes = (value: unknown) => encode(JSON.stringify(value, null, 2) + '\n');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const validateManifest = createSchemaValidator().compile<PackageManifest>(manifestSchema);
const validateRuntimeLock = createSchemaValidator().compile<RuntimeRequirementsLock>(runtimeSchema);

/** Canonical hashes identify logical JSON plans; file hashes still use the original exported bytes. */
export function canonicalDigest(value: unknown): string { return sha256(encode(canonicalize(value))); }

/** Private exports pin the design requirements and explicitly leave actual local host/model resolution unverified. */
function runtimeRequirements(workflow: Workflow, host: TargetHost): RuntimeRequirementsLock {
  return { schemaVersion: '1.0.0', kind: 'requirements', workflowSha256: canonicalDigest(workflow), runner: { version: '0.1.0', node: '24.22.1' }, requiredCapabilities: collectRequirements(workflow).capabilities, host: { name: host, verification: 'unverified', testedVersions: [] }, modelProfiles: workflow.modelProfiles, modelVerification: 'unverified' };
}

export interface PackageBuildInput {
  workflow: Workflow; editor?: unknown; resources?: Record<string, Uint8Array>; host: TargetHost;
  metadata?: { packageId?: string; packageVersion?: string; createdAt?: string };
}
export interface InspectOptions { limits?: Partial<ArchiveLimits>; trustStore?: Readonly<Record<string, string>>; requireSignature?: boolean; }

/** Build an operational snapshot. This function does not claim that a host or real model was tested. */
export async function buildPackage(input: PackageBuildInput): Promise<{ bytes: Uint8Array; manifest: PackageManifest }> {
  const checked = validateWorkflowShape(input.workflow);
  if (!checked.valid) throw new PackageError('WORKFLOW_INVALID', checked.issues.map(i => i.message).join('\n'));
  const errors = analyzeWorkflow(checked.value).filter(i => i.severity === 'error');
  if (errors.length) throw new PackageError('WORKFLOW_INVALID', errors.map(i => i.message).join('\n'));
  const requirements = collectRequirements(checked.value);
  const files = new Map<string, Uint8Array>();
  files.set('workflow.json', jsonBytes(checked.value));
  if (input.editor !== undefined) files.set('editor.json', jsonBytes(input.editor));
  files.set('runtime.lock.json', jsonBytes(runtimeRequirements(checked.value, input.host)));
  files.set('README.ko.md', encode('# 워크플로 실행 안내\n\n1. Studio Runner를 설치합니다.\n2. Runner에서 이 패키지를 가져와 파일과 요구 기능을 검사합니다.\n3. 실제 모델과 필요한 서비스 연결을 설정합니다. 키는 Runner에만 저장합니다.\n4. 선택한 AI 도구에서 이 폴더를 열고 실행을 요청합니다.\n5. 진행 상태와 결과를 확인합니다.\n\n파일 선택이나 사용자 응답을 기다리는 경우 Runner 화면에서 해당 실행을 열어 파일을 선택하거나 질문에 응답하세요. 선택한 파일만 해당 실행에 업로드합니다. 완성한 파일은 Runner 화면에서 다운로드할 수 있습니다.\n\n이 개인 패키지는 공식 검수·서명 또는 실제 호스트 실행 검증을 주장하지 않습니다.\n준비되지 않은 연결은 설정 필요로 표시됩니다. 가져오기만으로 모델·외부 작업·예약이 시작되지 않습니다.\n'));
  for (const [path, content] of Object.entries(createHostFiles(input.host))) files.set(path, encode(content));
  for (const [path, bytes] of Object.entries(input.resources ?? {})) {
    validatePackagePath(path);
    if (!path.startsWith('resources/')) throw new PackageError('RESOURCE_PATH', '자료는 resources/ 아래에만 배치할 수 있습니다.');
    files.set(path, bytes);
  }
  // Verify both the pinned descriptor and its transitive file inventory before exporting.
  const resources = verifyResources(checked.value.resources, files);
  const seen = new Set<string>();
  for (const [path, bytes] of files) { assertProductionFile(path, bytes); const key = pathKey(path); if (seen.has(key)) throw new PackageError('DUPLICATE_PATH', path); seen.add(key); }
  const role = (path: string): PackageManifest['files'][number]['role'] => path === 'workflow.json' ? 'workflow' : path === 'editor.json' ? 'editor' : path === 'runtime.lock.json' ? 'runtime-lock' : path.endsWith('SKILL.md') ? 'skill' : path.startsWith('resources/') ? 'resource' : ['AGENTS.md', 'CLAUDE.md'].includes(path) ? 'instructions' : path === 'README.ko.md' ? 'documentation' : 'host-config';
  const manifest: PackageManifest = {
    schemaVersion: '1.0.0', packageId: input.metadata?.packageId ?? `pkg_${randomUUID()}`, packageVersion: input.metadata?.packageVersion ?? `0.0.${checked.value.revision}`,
    packageKind: 'workflow', purpose: 'production', targetHost: input.host, entrypoint: 'workflow.json', requiredCapabilities: requirements.capabilities,
    compatibility: { runner: '^0.1.0', host: { verification: 'unverified', testedVersions: [] }, platforms: ['win32-x64'] },
    requestedPermissions: [...requirements.modelProfiles.map(target => ({ kind: 'model' as const, target })), ...requirements.resourceAliases.map(target => ({ kind: 'resource' as const, target })), ...[...new Set([...resources.values()].flatMap(resource => resource.requiredConnections))].sort().map(target => ({ kind: 'connection' as const, target }))],
    requiredConnections: [...new Set([...resources.values()].flatMap(resource => resource.requiredConnections))].sort(), resources: checked.value.resources as PackageManifest['resources'], indexes: [],
    files: [...files].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes), role: role(path) })) as PackageManifest['files'],
    createdAt: input.metadata?.createdAt ?? new Date().toISOString(),
  };
  return encodePackage(manifest, files);
}

/** Inventory and transport checks are shared by workflow and materials packages. */
async function encodePackage(manifest: PackageManifest, files: Map<string, Uint8Array>) {
  if (!validateManifest(manifest)) throw new PackageError('MANIFEST_INVALID', '배포 메타데이터가 규격에 맞지 않습니다.');
  for (const [path, content] of files) assertProductionFile(path, content);
  files.set('manifest.json', jsonBytes(manifest));
  const zipInput: Zippable = Object.create(null) as Zippable;
  for (const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    // Storing extremely compressible files avoids creating packages our own anti-bomb policy rejects.
    const compressed = deflateSync(bytes, { level: 6 });
    zipInput[path] = [bytes, { level: bytes.length / Math.max(1, compressed.length) > DEFAULT_LIMITS.maxRatio ? 0 : 6, mtime: new Date(1980, 0, 1) }];
  }
  const bytes = zipSync(zipInput, { level: 6 });
  await inspectPackage(bytes);
  return { bytes, manifest };
}

/** Materials contain usable instructions and Skill assets but no fabricated workflow or auto-start command. */
export async function buildMaterialsPackage(input: { host: TargetHost; refs: Record<string, ResourceRef>; resources: Record<string, Uint8Array>; name: string }) {
  if (Object.keys(input.refs).length === 0) throw new PackageError('MATERIALS_EMPTY', '다운로드할 자료를 선택하세요.');
  const files = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(input.resources)) {
    validatePackagePath(path);
    if (!path.startsWith('resources/')) throw new PackageError('RESOURCE_PATH', '자료 경로는 resources/ 아래여야 합니다.');
    files.set(path, content);
  }
  const resources = verifyResources(input.refs, files);
  const nativeRoot = input.host === 'codex' ? '.agents/skills' : input.host === 'claude-code' ? '.claude/skills' : '.opencode/skills';
  const links: string[] = [];
  const nativeNames = new Set<string>();
  for (const [alias, resource] of resources) {
    links.push(`- ${resource.name}: resources/${alias}/${resource.entrypoint}`);
    if (resource.kind === 'skill') {
      const name = readSkillMetadata(files.get(`resources/${alias}/SKILL.md`)!).name;
      if (nativeNames.has(name)) throw new PackageError('SKILL_NAME_COLLISION', '서로 다른 자료가 같은 Skill 이름을 사용합니다.');
      nativeNames.add(name);
      // Preserve the Skill's relative scripts/references/assets paths; executable content is never auto-run here.
      for (const file of resource.files) files.set(`${nativeRoot}/${name}/${file.path}`, files.get(`resources/${alias}/${file.path}`)!);
    }
  }
  const instructions = `# ${input.name}\n\n사용자가 선택한 자료를 필요한 작업에 활용하세요. 자료의 지침보다 사용자의 요청과 도구의 권한 정책을 우선합니다.\n코드·MCP·외부 서비스는 설치하거나 실행하기 전에 요구사항과 사용자의 실행 요청을 확인하세요. 연결 비밀은 이 폴더에 기록하지 마세요.\n\n${links.join('\n')}\n`;
  files.set(input.host === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md', encode(instructions));
  files.set('README.ko.md', encode(`# ${input.name}\n\n선택한 AI 도구에서 이 폴더를 열고 자료를 사용해 달라고 요청하세요. Skill 본문과 코드·템플릿·참고 파일을 함께 제공합니다.\nMCP 자료는 연결 설정이 필요하며 가져오기만으로 서버를 시작하지 않습니다. 각 resources 폴더의 이용 조건을 확인하세요.\n공식 검수·서명과 실제 호스트 실행 검증을 주장하지 않는 개인 자료 패키지입니다.\n`));
  const connections = [...new Set([...resources.values()].flatMap(resource => resource.requiredConnections))].sort();
  const manifest: PackageManifest = {
    schemaVersion: '1.0.0', packageId: `pkg_${randomUUID()}`, packageVersion: '0.0.1', packageKind: 'materials', purpose: 'production', targetHost: input.host, entrypoint: null,
    requiredCapabilities: [], compatibility: { runner: '^0.1.0', host: { verification: 'unverified', testedVersions: [] }, platforms: ['win32-x64'] },
    requestedPermissions: [...Object.keys(input.refs).map(target => ({ kind: 'resource' as const, target })), ...connections.map(target => ({ kind: 'connection' as const, target }))],
    requiredConnections: connections, resources: input.refs, indexes: [], createdAt: new Date().toISOString(),
    files: [...files].map(([path, content]) => ({ path, bytes: content.length, sha256: sha256(content), role: path.startsWith('resources/') ? 'resource' as const : path.endsWith('SKILL.md') ? 'skill' as const : 'instructions' as const })) as PackageManifest['files'],
  };
  return encodePackage(manifest, files);
}

/** Verify exact bytes before the Runner imports anything. Inspection has no execution or network side effects. */
export async function inspectPackage(bytes: Uint8Array, options: InspectOptions = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const files = readZip(bytes, limits);
  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) throw new PackageError('MANIFEST_MISSING', 'manifest.json이 없습니다.');
  const manifestValue = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  if (!validateManifest(manifestValue)) throw new PackageError('MANIFEST_INVALID', 'manifest.json 규격 검사에 실패했습니다.');
  const manifest = manifestValue;
  if (!manifest.createdAt.endsWith('Z') || (manifest.compatibility.host.verification === 'verified' && manifest.compatibility.host.testedVersions.length === 0)) throw new PackageError('MANIFEST_INVALID', '검증 버전 또는 UTC 배포 시각이 올바르지 않습니다.');
  const declared = new Set<string>();
  for (const item of manifest.files) {
    validatePackagePath(item.path);
    if (['manifest.json', 'manifest.sig'].includes(item.path) || declared.has(pathKey(item.path))) throw new PackageError('MANIFEST_INVALID', '중복 또는 자기 참조 파일 목록입니다.');
    declared.add(pathKey(item.path));
    const data = files.get(item.path);
    if (!data || data.length !== item.bytes || sha256(data) !== item.sha256) throw new PackageError('FILE_INTEGRITY', `파일 크기 또는 해시가 다릅니다: ${item.path}`);
    assertProductionFile(item.path, data);
  }
  for (const name of files.keys()) if (!['manifest.json', 'manifest.sig'].includes(name) && !declared.has(pathKey(name))) throw new PackageError('UNLISTED_FILE', `목록에 없는 파일입니다: ${name}`);
  const warnings: string[] = []; let trust: 'unsigned' | 'verified' = 'unsigned';
  const signatureBytes = files.get('manifest.sig');
  if (signatureBytes) {
    const signature = parseStrictJson(new TextDecoder().decode(signatureBytes)) as { algorithm?: string; keyId?: string; signature?: string };
    if (!signature || Object.keys(signature).some(key => !['algorithm', 'keyId', 'signature'].includes(key)) || signature.algorithm !== 'Ed25519' || typeof signature.keyId !== 'string' || typeof signature.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature.signature)) throw new PackageError('SIGNATURE_INVALID', '서명 형식이 잘못되었습니다.');
    const trustedKey = options.trustStore?.[signature.keyId];
    if (!trustedKey) throw new PackageError('SIGNATURE_UNTRUSTED', 'ZIP 외부의 신뢰 목록에서 서명 키를 찾지 못했습니다.');
    const key = createPublicKey(trustedKey);
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, encode('AI-WORKFLOW-STUDIO/PACKAGE/1\n' + canonicalize(manifest)), key, Buffer.from(signature.signature, 'base64url'))) throw new PackageError('SIGNATURE_INVALID', '서명이 일치하지 않습니다.');
    trust = 'verified';
  } else if (options.requireSignature) throw new PackageError('SIGNATURE_REQUIRED', '검증된 서명이 필요합니다.');
  else warnings.push('서명되지 않은 개인 패키지입니다. 공식 검수 여부를 확인할 수 없습니다.');
  let workflow: Workflow | undefined;
  if (manifest.packageKind === 'workflow') {
    if (manifest.entrypoint !== 'workflow.json' || !files.has('workflow.json')) throw new PackageError('ENTRYPOINT_INVALID', '실행 정의가 없습니다.');
    const parsed = validateWorkflowShape(parseStrictJson(new TextDecoder().decode(files.get('workflow.json')!)));
    if (!parsed.valid) throw new PackageError('WORKFLOW_INVALID', parsed.issues.map(i => i.message).join('\n'));
    workflow = parsed.value;
    const errors = analyzeWorkflow(workflow).filter(i => i.severity === 'error');
    if (errors.length) throw new PackageError('WORKFLOW_INVALID', errors.map(i => i.message).join('\n'));
    const needed = collectRequirements(workflow);
    const actual = needed.capabilities;
    if (canonicalize([...actual].sort()) !== canonicalize([...manifest.requiredCapabilities].sort())) throw new PackageError('CAPABILITIES_MISMATCH', '실제 블록과 요구 기능 선언이 다릅니다.');
    if (canonicalize(workflow.resources) !== canonicalize(manifest.resources)) throw new PackageError('RESOURCE_MISMATCH', '워크플로와 배포 자료 참조가 다릅니다.');
    const descriptors = verifyResources(workflow.resources, files);
    const connections = [...new Set([...descriptors.values()].flatMap(resource => resource.requiredConnections))].sort();
    if (canonicalize(connections) !== canonicalize([...manifest.requiredConnections].sort())) throw new PackageError('CONNECTIONS_MISMATCH', '자료의 연결 요구사항과 배포 선언이 다릅니다.');
    const permissions = [...needed.modelProfiles.map(target => ({ kind: 'model', target })), ...needed.resourceAliases.map(target => ({ kind: 'resource', target })), ...connections.map(target => ({ kind: 'connection', target }))];
    if (canonicalize(permissions.map(p => `${p.kind}:${p.target}`).sort()) !== canonicalize(manifest.requestedPermissions.map(p => `${p.kind}:${p.target}`).sort())) throw new PackageError('PERMISSIONS_MISMATCH', '실제 실행의 요구 권한과 배포 선언이 다릅니다.');
    for (const required of ['runtime.lock.json', 'README.ko.md', ...Object.keys(createHostFiles(manifest.targetHost))]) if (!files.has(required)) throw new PackageError('PACKAGE_INCOMPLETE', `운영 패키지에 필요한 파일이 없습니다: ${required}`);
    const runtimeLock = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(files.get('runtime.lock.json')!));
    if (!validateRuntimeLock(runtimeLock) || canonicalize(runtimeLock) !== canonicalize(runtimeRequirements(workflow, manifest.targetHost))) throw new PackageError('RUNTIME_LOCK_INVALID', '런타임 요구 목록이 현재 설계·모델·호스트와 다릅니다.');
    const generatedHostFiles = createHostFiles(manifest.targetHost);
    for (const [path, expected] of Object.entries(generatedHostFiles)) {
      if (sha256(files.get(path)!) !== sha256(encode(expected))) throw new PackageError('HOST_CONFIG_INVALID', '호스트 연결 파일은 검증된 Studio Bridge 형식이어야 합니다.');
    }
    const allowed = new Set(['workflow.json', 'editor.json', 'runtime.lock.json', 'README.ko.md', ...Object.keys(generatedHostFiles)]);
    for (const path of files.keys()) if (!['manifest.json', 'manifest.sig'].includes(path) && !path.startsWith('resources/') && !allowed.has(path)) throw new PackageError('UNSUPPORTED_PACKAGE_FILE', `지원하지 않는 실행 패키지 파일입니다: ${path}`);
  } else {
    if (manifest.entrypoint !== null || manifest.requiredCapabilities.length || files.has('workflow.json')) throw new PackageError('MATERIALS_INVALID', '자료 패키지는 실행 진입점을 선언할 수 없습니다.');
    const descriptors = verifyResources(manifest.resources as Record<string, ResourceRef>, files);
    const connections = [...new Set([...descriptors.values()].flatMap(resource => resource.requiredConnections))].sort();
    if (descriptors.size === 0 || canonicalize(connections) !== canonicalize([...manifest.requiredConnections].sort()) || !files.has('README.ko.md')) throw new PackageError('MATERIALS_INVALID', '자료 패키지의 본문 또는 연결 선언이 일치하지 않습니다.');
    const nativeRoot = manifest.targetHost === 'codex' ? '.agents/skills' : manifest.targetHost === 'claude-code' ? '.claude/skills' : '.opencode/skills';
    const allowed = new Set(['README.ko.md', manifest.targetHost === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md']);
    const nativeNames = new Set<string>();
    for (const [alias, resource] of descriptors) if (resource.kind === 'skill') {
      const name = readSkillMetadata(files.get(`resources/${alias}/SKILL.md`)!).name;
      if (nativeNames.has(name)) throw new PackageError('SKILL_NAME_COLLISION', '서로 다른 자료가 같은 Skill 이름을 사용합니다.');
      nativeNames.add(name);
      for (const file of resource.files) {
      const path = `${nativeRoot}/${name}/${file.path}`;
      const native = files.get(path), original = files.get(`resources/${alias}/${file.path}`)!;
      if (!native || sha256(native) !== sha256(original)) throw new PackageError('SKILL_INTEGRITY', 'AI 도구용 Skill 사본이 고정한 원본과 다릅니다.');
      allowed.add(path);
      }
    }
    for (const path of files.keys()) if (!['manifest.json', 'manifest.sig'].includes(path) && !path.startsWith('resources/') && !allowed.has(path)) throw new PackageError('UNSUPPORTED_PACKAGE_FILE', `지원하지 않는 자료 패키지 파일입니다: ${path}`);
  }
  return { manifest, workflow, files, trust, warnings };
}

/** Read only the declared snapshot from a host's fixed project folder, rejecting junction/symlink escapes. */
export async function readPackageDirectory(directory: string, options: InspectOptions = {}): Promise<Uint8Array> {
  const root = resolve(directory);
  if ((await lstat(root)).isSymbolicLink()) throw new PackageError('UNSAFE_DIRECTORY', '패키지 루트는 링크일 수 없습니다.');
  const realRoot = await realpath(root);
  async function safeRead(path: string, maximum = DEFAULT_LIMITS.maxFileBytes): Promise<Uint8Array> {
    validatePackagePath(path);
    let current = root;
    for (const segment of path.split('/')) {
      current = join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw new PackageError('UNSAFE_DIRECTORY', `링크를 포함한 패키지 경로: ${path}`);
    }
    const actual = await realpath(current), inside = relative(realRoot, actual);
    if (inside.startsWith('..') || isAbsolute(inside)) throw new PackageError('UNSAFE_DIRECTORY', '패키지 폴더 밖의 파일입니다.');
    const info = await lstat(current);
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum) throw new PackageError('ARCHIVE_LIMIT', '파일 종류·링크 또는 크기가 허용 범위를 벗어났습니다.');
    const handle = await open(current, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new PackageError('FILE_CHANGED', '읽기 전에 패키지 파일이 교체되었습니다.');
      // Read at most the inspected size plus one sentinel byte: a growing file cannot cause an unbounded allocation.
      const buffer = Buffer.alloc(info.size + 1); let offset = 0;
      while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, Math.min(65536, buffer.length - offset), offset); if (!bytesRead) break; offset += bytesRead; }
      const after = await handle.stat(); const pathAfter = await lstat(current);
      if (offset !== info.size || after.size !== info.size || after.nlink !== 1 || pathAfter.isSymbolicLink() || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) throw new PackageError('FILE_CHANGED', '읽는 동안 패키지 파일이 변경되었습니다.');
      return buffer.subarray(0, offset);
    } finally { await handle.close(); }
  }
  const manifestBytes = await safeRead('manifest.json', DEFAULT_LIMITS.maxManifestBytes);
  const value = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  if (!validateManifest(value)) throw new PackageError('MANIFEST_INVALID', '폴더의 manifest가 규격에 맞지 않습니다.');
  const zip: Zippable = Object.create(null) as Zippable;
  zip['manifest.json'] = [manifestBytes, { level: 0, mtime: new Date(1980, 0, 1) }];
  let total = manifestBytes.length;
  for (const item of value.files) {
    if (['manifest.json', 'manifest.sig'].includes(item.path) || Object.hasOwn(zip, item.path)) throw new PackageError('MANIFEST_INVALID', '잘못된 파일 목록입니다.');
    const data = await safeRead(item.path); total += data.length;
    if (total > DEFAULT_LIMITS.maxTotalBytes) throw new PackageError('ARCHIVE_LIMIT', '패키지 총 크기가 한도를 초과했습니다.');
    zip[item.path] = [data, { level: 0, mtime: new Date(1980, 0, 1) }];
  }
  try { zip['manifest.sig'] = [await safeRead('manifest.sig', 4096), { level: 0, mtime: new Date(1980, 0, 1) }]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const bytes = zipSync(zip, { level: 0 });
  // Signed imports need a caller-owned trust store; a package never grants trust to its own key.
  await inspectPackage(bytes, options);
  return bytes;
}
