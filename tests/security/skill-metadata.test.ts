import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildMaterialsPackage, inspectPackage, readSkillMetadata, type ResourceDescriptor, type TargetHost } from '@studio/package-kit';
import type { ResourceRef } from '@studio/spec';

const bytes = (text: string) => new TextEncoder().encode(text);
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function resource(alias: string, name = 'usable-skill') {
  const files = { 'SKILL.md': bytes(`---\nname: ${name}\ndescription: Read supplied source material and fill the local result template.\n---\n\nRead only the supplied source. Separate unknown values. Fill assets/result.md.\n`), 'assets/result.md': bytes('# Result\n\n## Confirmed\n\n## Unknown\n'), 'LICENSE.md': bytes('Original internal contract-test material. CC0-1.0.\n') };
  const descriptor: ResourceDescriptor = { schemaVersion: '1.0.0', id: alias, revision: 1, kind: 'skill', name: '검증용 지침', entrypoint: 'SKILL.md', license: { id: 'CC0-1.0', path: 'LICENSE.md' }, dependencies: {}, requiredConnections: [], files: Object.entries(files).map(([path, value]) => ({ path, bytes: value.length, sha256: hash(value) })) as ResourceDescriptor['files'] };
  const definition = bytes(JSON.stringify(descriptor));
  const reference: ResourceRef = { kind: 'skill', id: alias, revision: 1, sha256: hash(definition) };
  return { reference, files: Object.fromEntries(Object.entries({ 'resource.json': definition, ...files }).map(([path, value]) => [`resources/${alias}/${path}`, value])) };
}

/** Resource aliases are stable catalogue IDs; native Skill directory names come from validated metadata. */
describe('portable native Skills', () => {
  it.each<TargetHost>(['codex', 'claude-code', 'opencode'])('maps an uppercase resource alias to the Skill name for %s', async host => {
    const source = resource('ER-061'); const built = await buildMaterialsPackage({ host, name: 'Skill', refs: { 'ER-061': source.reference }, resources: source.files });
    const result = await inspectPackage(built.bytes);
    expect([...result.files.keys()].some(path => path.endsWith('/skills/usable-skill/SKILL.md'))).toBe(true);
    expect([...result.files.keys()].some(path => path.includes('/skills/ER-061/'))).toBe(false);
    expect(result.files.has('resources/ER-061/SKILL.md')).toBe(true);
  });
  it('rejects name collisions across different resource aliases', async () => {
    const first = resource('ER-061'), second = resource('ER-062');
    await expect(buildMaterialsPackage({ host: 'codex', name: 'Skills', refs: { 'ER-061': first.reference, 'ER-062': second.reference }, resources: { ...first.files, ...second.files } })).rejects.toMatchObject({ code: 'SKILL_NAME_COLLISION' });
  });
  it('accepts quoted and folded descriptive metadata without losing the exact name', () => {
    const value = readSkillMetadata(bytes('---\nname: "usable-skill"\ndescription: >-\n  Use source: facts only.\n  Preserve unknowns.\nmetadata:\n  version: "1.0"\n---\nInstructions.'));
    expect(value.name).toBe('usable-skill'); expect(value.description).toBe('Use source: facts only. Preserve unknowns.'); expect(value.metadata?.version).toBe('1.0');
  });
  it.each([
    'name: ../escape\ndescription: Unsafe name', 'name: Uppercase\ndescription: Invalid', 'name: double--hyphen\ndescription: Invalid',
    'name: usable-skill\nname: duplicate\ndescription: Invalid', 'name: usable-skill\ndescription: text\nallowed-tools: Bash(*)',
    'name: usable-skill\ndescription: text\nhooks: anything', 'name: &alias usable-skill\ndescription: *alias',
    'name: usable-skill\ndescription: text\nmetadata:\n  constructor: hidden', 'name: usable-skill',
  ])('rejects malformed or authority-changing frontmatter: %s', yaml => {
    expect(() => readSkillMetadata(bytes(`---\n${yaml}\n---\nActual instructions.`))).toThrow();
  });
});
