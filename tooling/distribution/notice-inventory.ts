import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface NoticeInput { id: string; contents?: Uint8Array; generatedOwner?: string; generatedLabel?: string }
interface NoticeFile { source: string; outputPath: string; bytes: number; sha256: string }
interface ModuleRecord { path: string; bytes: number; sha256: string }
export interface NoticeComponent { id: string; name: string; version: string; declaredLicense: string | null; packageJsonSha256: string; modules: ModuleRecord[]; notices: NoticeFile[] }
export interface NoticeInventory { schemaVersion: '1.0.0'; scope: string; components: NoticeComponent[]; gaps: { code: string; componentId?: string; input?: string }[]; noticeComplete: boolean; releaseApproved: false }
export interface NoticeBundle { inventory: NoticeInventory; assets: Map<string, Uint8Array> }
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const slash = (value: string) => value.replaceAll('\\', '/');
const within = (root: string, path: string) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part); };
const noticeName = /^(?:licen[cs]es?|copying|notices?|third[-_ ]party[-_ ](?:notices|licenses))(?:[._-].*)?$/i;
const executableNoticeName = /\.(?:js|mjs|cjs|jsx|ts|tsx|py|sh|bat|cmd|ps1|exe|dll|wasm)$/i;
const safeRelative = (value: string) => value.length < 400 && /^[A-Za-z0-9@_./+-]+$/.test(value) && !value.split('/').some((part) => !part || part === '.' || part === '..') && !isAbsolute(value);
const safeNoticePath = (value: string) => safeRelative(value) && !value.split('/').some((part) => part.startsWith('.') || part === 'node_modules');

/** Read bounded, ordinary files; never chase a notice symlink/junction into an unrelated directory. */
async function ordinaryFile(path: string, ownerRoot: string, maximum = 1024 * 1024): Promise<Uint8Array> {
  const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > maximum || !within(ownerRoot, await realpath(path))) throw new Error('UNSAFE_NOTICE_FILE');
  const bytes = await readFile(path); if (bytes.length !== info.size || bytes.length > maximum) throw new Error('CHANGED_NOTICE_FILE'); return bytes;
}

/** Locate the actual package owning a shipped input, ignoring metadata-only dist/package.json files without identity. */
async function packageOwner(file: string, workspace: string) {
  let directory = dirname(file);
  while (within(workspace, directory)) {
    try {
      const bytes = await ordinaryFile(join(directory, 'package.json'), workspace); const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (typeof value.name === 'string' && /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(value.name) && typeof value.version === 'string' && /^[A-Za-z0-9.+_-]{1,100}$/.test(value.version)) return { root: directory, name: value.name as string, version: value.version as string, license: typeof value.license === 'string' && value.license.length <= 500 ? value.license : typeof value.license?.type === 'string' && value.license.type.length <= 500 ? value.license.type : null, sha256: sha(bytes) };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (directory === workspace) break; directory = dirname(directory);
  }
  throw new Error('PACKAGE_IDENTITY_MISSING');
}

/** Only listed production inputs are traversed. Unused dependencies, tests and hidden node_modules trees are never copied. */
export async function collectNoticeInventory(options: { workspaceRoot: string; scope: string; inputs: readonly NoticeInput[] }): Promise<NoticeBundle> {
  if (!/^[a-z0-9_-]{1,60}$/.test(options.scope) || options.inputs.length > 20000) throw new Error('NOTICE_INPUT_INVALID');
  const workspace = await realpath(resolve(options.workspaceRoot)); const components = new Map<string, NoticeComponent>(); const roots = new Map<string, string>(); const directories = new Map<string, Set<string>>(); const assets = new Map<string, Uint8Array>(); const gaps: NoticeInventory['gaps'] = [];
  for (const input of options.inputs) {
    // Virtual IDs may contain local absolute paths, so un-attributed IDs are identified only by a digest.
    const redacted = `input-${sha(input.id).slice(0, 20)}`;
    try {
      const virtual = Boolean(input.generatedOwner) || input.id.includes('\0') || input.id.startsWith('virtual:');
      if (virtual && !input.generatedOwner) { gaps.push({ code: 'GENERATED_INPUT_UNATTRIBUTED', input: redacted }); continue; }
      if (virtual && !input.contents) throw new Error('GENERATED_SOURCE_MISSING');
      const clean = input.id.replace(/^\/[@]fs\//, '').split('?')[0]!;
      const file = await realpath(resolve(workspace, input.generatedOwner ?? clean)); if (!within(workspace, file)) throw new Error('INPUT_OUTSIDE_WORKSPACE');
      const owner = await packageOwner(file, workspace); const id = `${owner.name.replaceAll('/', '_').replaceAll('@', '')}-${owner.version}-${owner.sha256.slice(0, 12)}`;
      let component = components.get(id); if (!component) { component = { id, name: owner.name, version: owner.version, declaredLicense: owner.license, packageJsonSha256: owner.sha256, modules: [], notices: [] }; components.set(id, component); roots.set(id, owner.root); directories.set(id, new Set([owner.root])); }
      const contents = input.contents ?? await ordinaryFile(file, workspace, 128 * 1024 * 1024); const modulePath = virtual ? `generated/${input.generatedLabel ?? redacted}` : slash(relative(owner.root, file));
      if (!safeRelative(modulePath)) throw new Error('INPUT_PATH_INVALID');
      const prior = component.modules.find((item) => item.path === modulePath); const record = { path: modulePath, bytes: contents.length, sha256: sha(contents) };
      if (prior && (prior.sha256 !== record.sha256 || prior.bytes !== record.bytes)) throw new Error('INPUT_IDENTITY_CONFLICT'); if (!prior) component.modules.push(record);
      let directory = dirname(file); while (within(owner.root, directory)) { directories.get(id)!.add(directory); if (directory === owner.root) break; directory = dirname(directory); }
    } catch (error) { gaps.push({ code: (error as Error).message.match(/^[A-Z_]+$/)?.[0] ?? 'INPUT_INSPECTION_FAILED', input: redacted }); }
  }
  for (const component of components.values()) {
    const root = roots.get(component.id)!; const candidates = new Set<string>();
    if (!component.declaredLicense) gaps.push({ code: 'LICENSE_DECLARATION_MISSING', componentId: component.id });
    for (const directory of directories.get(component.id)!) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (noticeName.test(entry.name) && !executableNoticeName.test(entry.name)) { if (entry.isFile() || entry.isSymbolicLink()) candidates.add(join(directory, entry.name)); else if (entry.isDirectory() && /^licenses?$/i.test(entry.name)) { for (const nested of await readdir(join(directory, entry.name), { withFileTypes: true })) if ((nested.isFile() || nested.isSymbolicLink()) && !executableNoticeName.test(nested.name)) candidates.add(join(directory, entry.name, nested.name)); } }
      }
    }
    const referenced = /^SEE LICEN[CS]E IN (.+)$/i.exec(component.declaredLicense ?? '')?.[1]; if (referenced && safeNoticePath(referenced) && !executableNoticeName.test(referenced)) candidates.add(join(root, referenced)); else if (referenced) gaps.push({ code: 'LICENSE_REFERENCE_UNSAFE', componentId: component.id });
    if (candidates.size > 200) { gaps.push({ code: 'NOTICE_FILE_LIMIT', componentId: component.id }); continue; }
    for (const file of [...candidates].sort()) {
      try { const source = slash(relative(root, file)); if (!safeNoticePath(source)) throw new Error('NOTICE_PATH_INVALID'); const bytes = await ordinaryFile(file, root); const outputPath = `notices/${options.scope}/${component.id}/${source}`; assets.set(outputPath, bytes); component.notices.push({ source: `package/${source}`, outputPath, bytes: bytes.length, sha256: sha(bytes) }); }
      catch { gaps.push({ code: 'NOTICE_FILE_UNREADABLE', componentId: component.id }); }
    }
  }
  // The shipped npm package may omit upstream LICENSE. Supplements require pinned source provenance and byte equality.
  const supplementalRoot = join(workspace, 'tooling/distribution/notices');
  try {
    const provenance = JSON.parse(new TextDecoder().decode(await ordinaryFile(join(supplementalRoot, 'provenance.json'), supplementalRoot))) as { packages: { name: string; version: string; packageJsonSha256?: string; gitHead: string; notices: { path: string; sha256: string; source: string }[] }[] };
    for (const component of components.values()) for (const source of provenance.packages.filter((item) => item.name === component.name && item.version === component.version)) {
      if (!source.packageJsonSha256 || source.packageJsonSha256 !== component.packageJsonSha256 || !/^[a-f0-9]{40}$/.test(source.gitHead)) { gaps.push({ code: 'SUPPLEMENT_PROVENANCE_MISMATCH', componentId: component.id }); continue; }
      for (const notice of source.notices) {
        try { if (!safeNoticePath(notice.path) || !notice.source.startsWith('https://raw.githubusercontent.com/') || !notice.source.includes(`/${source.gitHead}/`)) throw new Error(); const bytes = await ordinaryFile(join(supplementalRoot, notice.path), supplementalRoot); if (sha(bytes) !== notice.sha256) throw new Error(); const outputPath = `notices/${options.scope}/${component.id}/upstream/${basename(notice.path)}`; assets.set(outputPath, bytes); component.notices.push({ source: notice.source, outputPath, bytes: bytes.length, sha256: sha(bytes) }); }
        catch { gaps.push({ code: 'SUPPLEMENT_NOTICE_INVALID', componentId: component.id }); }
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') gaps.push({ code: 'SUPPLEMENT_REGISTRY_INVALID' }); }
  for (const component of components.values()) { component.modules.sort((a, b) => a.path.localeCompare(b.path, 'en')); component.notices.sort((a, b) => a.outputPath.localeCompare(b.outputPath, 'en')); if (!component.notices.length) gaps.push({ code: 'LICENSE_OR_NOTICE_FILE_MISSING', componentId: component.id }); }
  if (!components.size) gaps.push({ code: 'NO_PRODUCTION_INPUTS' });
  const inventory: NoticeInventory = { schemaVersion: '1.0.0', scope: options.scope, components: [...components.values()].sort((a, b) => a.id.localeCompare(b.id, 'en')), gaps, noticeComplete: gaps.length === 0, releaseApproved: false };
  assets.set(`notices/${options.scope}/inventory.json`, new TextEncoder().encode(JSON.stringify(inventory, null, 2) + '\n'));
  return { inventory, assets };
}

/** Revalidate a previous UI build before packaging it; a JSON claim cannot hide a missing or modified notice asset. */
export async function verifyNoticeInventory(inventory: NoticeInventory, readAsset: (path: string) => Promise<Uint8Array>) {
  if (inventory.schemaVersion !== '1.0.0' || !/^[a-z0-9_-]{1,60}$/.test(inventory.scope) || inventory.releaseApproved !== false || !Array.isArray(inventory.components) || !Array.isArray(inventory.gaps) || !inventory.components.length) throw new Error('NOTICE_INVENTORY_INVALID');
  const paths = new Set<string>(); let complete = inventory.gaps.length === 0;
  for (const component of inventory.components) {
    if (!component.id || !safeRelative(component.id) || !Array.isArray(component.modules) || !component.modules.length || !Array.isArray(component.notices) || !/^[a-f0-9]{64}$/.test(component.packageJsonSha256)) throw new Error('NOTICE_COMPONENT_INVALID');
    if (!component.declaredLicense || !component.notices.length) complete = false;
    for (const module of component.modules) if (!safeRelative(module.path) || !Number.isSafeInteger(module.bytes) || module.bytes < 0 || !/^[a-f0-9]{64}$/.test(module.sha256)) throw new Error('NOTICE_MODULE_INVALID');
    for (const notice of component.notices) {
      if (!safeRelative(notice.outputPath) || !notice.outputPath.startsWith(`notices/${inventory.scope}/${component.id}/`) || paths.has(notice.outputPath) || !Number.isSafeInteger(notice.bytes) || notice.bytes < 1 || notice.bytes > 1024 * 1024 || !/^[a-f0-9]{64}$/.test(notice.sha256)) throw new Error('NOTICE_ASSET_INVALID');
      paths.add(notice.outputPath); const bytes = await readAsset(notice.outputPath); if (bytes.length !== notice.bytes || sha(bytes) !== notice.sha256) throw new Error('NOTICE_ASSET_INTEGRITY');
    }
  }
  if (inventory.noticeComplete !== complete) throw new Error('NOTICE_COMPLETENESS_MISMATCH');
  return { noticeComplete: complete };
}
