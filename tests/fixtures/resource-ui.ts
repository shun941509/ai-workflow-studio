import { createHash } from 'node:crypto';
import { createTextResource, type ResourceDescriptor } from '@studio/package-kit';
import type { ResourceRef } from '@studio/spec';
import type { PrivateResourceDetail, PrivateResourceSummary } from '../../apps/studio-web/src/features/resources/types';

const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const bytes = (text: string) => new TextEncoder().encode(text);
export const accountId = (number: number) => `10000000-0000-4000-8000-${number.toString().padStart(12, '0')}`;
export type MaterialFixture = { alias: string; detail: PrivateResourceDetail; summary: PrivateResourceSummary; files: Record<string, Uint8Array> };

/** Internal fixtures contain real descriptors and payload hashes; only the authenticated HTTP transport is replaced. */
export function resourceFixture(number: number, kind: 'instruction' | 'document' | 'skill' = 'instruction', dependencies: MaterialFixture[] = [], revision = 1): MaterialFixture {
  const alias = `original_alias_${number}`, id = `original_source_${number}`, name = kind === 'skill' ? '회의 정리 Skill' : `자료 ${number}`;
  const text = `검증용 원본 ${number} 버전 ${revision}. <script>window.previewExecuted=true</script>`;
  let descriptor: ResourceDescriptor; let contentFiles: Record<string, Uint8Array>;
  if (kind === 'skill') {
    contentFiles = { 'SKILL.md': bytes('---\nname: meeting-summary\ndescription: Summarize explicit decisions from supplied notes.\n---\nUse assets/template.md. Preserve source facts.\n'), 'assets/template.md': bytes('# Decisions\n'), 'LICENSE.txt': bytes('Original internal test fixture. CC0-1.0.\n') };
    descriptor = { schemaVersion: '1.0.0', id, revision, kind, name, entrypoint: 'SKILL.md', license: { id: 'CC0-1.0', path: 'LICENSE.txt' }, dependencies: {}, requiredConnections: [], files: Object.entries(contentFiles).map(([path, data]) => ({ path, bytes: data.length, sha256: hash(data) })) as ResourceDescriptor['files'] };
  } else {
    const material = createTextResource({ id, revision, name, kind, text }); descriptor = material.descriptor;
    contentFiles = Object.fromEntries(Object.entries(material.files).filter(([path]) => !path.endsWith('/resource.json')).map(([path, data]) => [path.slice(`resources/${id}/`.length), data]));
  }
  descriptor.dependencies = Object.fromEntries(dependencies.map(dependency => [dependency.alias, dependency.detail.version.reference]));
  const definition = bytes(JSON.stringify(descriptor)); const reference: ResourceRef = { id, kind, revision, sha256: hash(definition) };
  const versionId = accountId(10000 + number * 100 + revision), resourceId = accountId(number);
  const refs = Object.assign({}, ...dependencies.map(item => item.detail.refs), { [alias]: reference }) as Record<string, ResourceRef>;
  const resourceBindings = Object.assign({}, ...dependencies.map(item => item.detail.resourceBindings), { [alias]: versionId }) as Record<string, string>;
  const resourceDependencies = Object.assign({}, ...dependencies.map(item => item.detail.resourceDependencies), { [alias]: dependencies.map(item => item.alias) }) as Record<string, string[]>;
  const ownFiles = Object.fromEntries(Object.entries({ ...contentFiles, 'resource.json': definition }).map(([path, data]) => [`resources/${alias}/${path}`, data]));
  const files = Object.assign({}, ...dependencies.map(item => item.files), ownFiles) as Record<string, Uint8Array>;
  const description = '고정 원본과 계정 버전이 서로 다른 자료';
  const content: PrivateResourceDetail['version']['content'] = { format: 'archive_v1', name, kind, description, license: descriptor.license, files: descriptor.files };
  const detail: PrivateResourceDetail = { resource: { id: resourceId, name, kind, description }, version: { id: versionId, revision, content, reference }, refs, resourceBindings, resourceDependencies, origin: { source: { packageId: 'original-example', packageVersion: '1.0.0', artifactSha256: hash(definition), storage_path: 'must-never-render' }, copied_at: '2026-10-28T00:00:00Z' } };
  return { alias, detail, files, summary: { ...detail.resource, versionsTruncated: false, resource_versions: [{ id: versionId, revision, content: { format: content.format, name, kind, description } }] } };
}

/** Private text is a separate server format: its descriptor id and alias are the account resource UUID. */
export function legacyTextFixture(number: number): MaterialFixture {
  const alias = accountId(number), versionId = accountId(50000 + number), name = `개인 문서 ${number}`, description = '계정에서 직접 저장한 텍스트', text = '원문 <script>window.previewExecuted=true</script>';
  const material = createTextResource({ id: alias, revision: 1, name, kind: 'document', text }); const content = { format: 'text' as const, name, kind: 'document' as const, description, text };
  const detail: PrivateResourceDetail = { resource: { id: alias, name, kind: 'document', description }, version: { id: versionId, revision: 1, content, reference: material.reference }, refs: { [alias]: material.reference }, resourceBindings: { [alias]: versionId }, resourceDependencies: { [alias]: [] }, origin: null };
  return { alias, detail, files: material.files, summary: { ...detail.resource, versionsTruncated: false, resource_versions: [{ id: versionId, revision: 1, content: { format: 'text', name, kind: 'document', description } }] } };
}
