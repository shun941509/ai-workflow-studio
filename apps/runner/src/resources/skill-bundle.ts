import { readSkillMetadata, type ResourceDescriptor, type SkillMetadata } from '@studio/package-kit';
import { RunnerError } from '../errors.js';

export interface SkillFileView { path: string; bytes: number; sha256: string; trust: 'untrusted'; content: 'text' | 'binary_metadata'; text?: string }
export interface SkillBundle { resource: { alias: string; id: string; revision: number; sha256: string }; metadata: SkillMetadata; instructions: string; references: SkillFileView[]; assets: SkillFileView[]; excludedFiles: { path: string; bytes: number; sha256: string; reason: 'execution_not_supported' | 'not_selected' }[] }

/** A Skill is a verified instruction/data bundle. This module has no process, filesystem, network, or model API. */
export function createSkillBundle(alias: string, descriptor: ResourceDescriptor, sha256: string, files: ReadonlyMap<string, Uint8Array>): SkillBundle {
  const bytes = files.get(`resources/${alias}/SKILL.md`)!; const metadata = readSkillMetadata(bytes);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)!; const instructions = text.slice(frontmatter[0].length);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(instructions)) throw new RunnerError('RESOURCE_BINARY_UNSUPPORTED', 'SKILL.md 본문에는 UTF-8 텍스트 지침이 필요합니다.');
  const bundle: SkillBundle = { resource: { alias, id: descriptor.id, revision: descriptor.revision, sha256 }, metadata, instructions, references: [], assets: [], excludedFiles: [] };
  for (const file of descriptor.files) {
    if (file.path === 'SKILL.md' || file.path === descriptor.license.path) continue;
    if (file.path.startsWith('references/') || file.path.startsWith('assets/')) {
      const view: SkillFileView = { ...file, trust: 'untrusted', content: 'binary_metadata' };
      try { const decoded = new TextDecoder('utf-8', { fatal: true }).decode(files.get(`resources/${alias}/${file.path}`)!); if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(decoded)) { view.content = 'text'; view.text = decoded; } } catch { /* Binary assets remain verified metadata and are never silently decoded or executed. */ }
      (file.path.startsWith('references/') ? bundle.references : bundle.assets).push(view);
    } else bundle.excludedFiles.push({ ...file, reason: file.path.startsWith('scripts/') ? 'execution_not_supported' : 'not_selected' });
  }
  return bundle;
}
