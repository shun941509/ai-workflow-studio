import { createHash } from 'node:crypto';
import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createBasicWorkflow, type ResourceRef } from '@studio/spec';
import { buildPackage, buildMaterialsPackage, createTextResource, inspectPackage, type ResourceDescriptor, type TargetHost } from '@studio/package-kit';

/** A usable Skill fixture pins real instructions, a template, and licensing rather than a placeholder file. */
function material() {
  const bytes = (value: string) => strToU8(value);
  const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
  const content = {
    'SKILL.md': bytes('---\nname: meeting-summary\ndescription: Turn meeting notes into confirmed decisions and action items.\n---\n\nRead the supplied notes. Separate confirmed decisions from open questions. Fill assets/summary.md. Preserve owners and dates as written; mark missing values as unknown.\n'),
    'assets/summary.md': bytes('# Meeting summary\n\n## Decisions\n\n## Actions\n\n| Action | Owner | Due date |\n| --- | --- | --- |\n\n## Open questions\n'),
    'LICENSE.txt': bytes('Original test content. Licensed under CC0 1.0 Universal.\n'),
  };
  const descriptor: ResourceDescriptor = {
    schemaVersion: '1.0.0', id: 'meeting-summary', revision: 1, kind: 'skill', name: '회의 결정·할 일 정리', entrypoint: 'SKILL.md',
    license: { id: 'CC0-1.0', path: 'LICENSE.txt' }, dependencies: {}, requiredConnections: [],
    files: Object.entries(content).map(([path, data]) => ({ path, bytes: data.length, sha256: hash(data) })) as ResourceDescriptor['files'],
  };
  const definition = bytes(JSON.stringify(descriptor));
  const reference: ResourceRef = { kind: 'skill', id: descriptor.id, revision: 1, sha256: hash(definition) };
  const files = Object.fromEntries(Object.entries({ 'resource.json': definition, ...content }).map(([path, data]) => [`resources/meeting-summary/${path}`, data]));
  return { reference, files };
}

describe('pinned resources and usable materials', () => {
  it('materializes a stable private text revision without claiming public redistribution rights', async () => {
    const input = { id: 'writing-guide', revision: 1, name: '작성 지침', kind: 'instruction' as const, text: '확인된 사실과 미확인 정보를 구분하세요.' };
    const first = createTextResource(input), second = createTextResource(input);
    expect(first.reference.sha256).toBe(second.reference.sha256);
    expect(first.descriptor.license.id).toBe('LicenseRef-Proprietary');
    const built = await buildMaterialsPackage({ host: 'codex', name: input.name, refs: { [input.id]: first.reference }, resources: first.files });
    expect((await inspectPackage(built.bytes)).manifest.resources[input.id]).toEqual(first.reference);
  });
  it.each<TargetHost>(['codex', 'claude-code', 'opencode'])('exports native Skill assets for %s without a fake executable flow', async host => {
    const source = material();
    const built = await buildMaterialsPackage({ host, name: '회의 자료', refs: { 'meeting-summary': source.reference }, resources: source.files });
    const imported = await inspectPackage(built.bytes);
    expect(imported.manifest.packageKind).toBe('materials');
    expect(imported.workflow).toBeUndefined();
    expect(imported.files.has('workflow.json')).toBe(false);
    expect([...imported.files.keys()].some(path => path.includes('/skills/meeting-summary/assets/summary.md'))).toBe(true);
  });
  it('rejects a material whose descriptor or template differs from the pinned reference', async () => {
    const source = material();
    const workflow = createBasicWorkflow(); workflow.resources['meeting-summary'] = source.reference;
    await expect(buildPackage({ workflow, host: 'codex', resources: { ...source.files, 'resources/meeting-summary/assets/summary.md': strToU8('changed') } })).rejects.toMatchObject({ code: 'RESOURCE_INTEGRITY' });
    source.reference.sha256 = '0'.repeat(64);
    await expect(buildPackage({ workflow, host: 'codex', resources: source.files })).rejects.toMatchObject({ code: 'RESOURCE_INTEGRITY' });
  });
  it('rejects extra payloads not listed by the resource author', async () => {
    const source = material();
    await expect(buildMaterialsPackage({ host: 'codex', name: '자료', refs: { 'meeting-summary': source.reference }, resources: { ...source.files, 'resources/meeting-summary/inject.sh': strToU8('echo extra') } })).rejects.toMatchObject({ code: 'RESOURCE_UNLISTED' });
  });
});
