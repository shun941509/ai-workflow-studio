import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalize } from 'json-canonicalize';
import { unzipSync, zipSync } from 'fflate';
import { createBasicWorkflow, type ResourceRef } from '@studio/spec';
import { buildMaterialsPackage, buildPackage, createTextResource, inspectPackage, prepareAuthoringImport, type ResourceDescriptor } from '@studio/package-kit';

const bytes = (text: string) => new TextEncoder().encode(text);
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Distinct alias/id, real dependency, binary bytes, code, template and CRLF exercise lossless copy boundaries. */
function materials() {
  const dependency = createTextResource({ id: 'original-guide', revision: 3, name: '기록 지침', kind: 'instruction', text: '\uFEFF확인된 내용만 기록합니다.\r\n' });
  const guideFiles = Object.fromEntries(Object.entries(dependency.files).map(([path, value]) => [path.replace('resources/original-guide/', 'resources/guide-alias/'), value]));
  const payload = {
    'SKILL.md': bytes('---\nname: original-reading\ndescription: Read the supplied document and fill the included template.\n---\nRead source evidence using the guide. Preserve quotes in assets/record.md.\n'),
    'assets/record.md': bytes('# 기록\r\n\r\n{{quote}}\r\n'),
    'assets/sample.bin': new Uint8Array([0, 255, 128, 13, 10, 42]),
    'scripts/format.py': bytes('# Formatting asset; importing a package must never execute it.\nprint("must not execute during import")\n'),
    'LICENSE.txt': bytes('Original test content. CC0-1.0.\r\n'),
  };
  const descriptor: ResourceDescriptor = { schemaVersion: '1.0.0', id: 'original-skill', revision: 7, name: '원본 읽기', kind: 'skill', entrypoint: 'SKILL.md', license: { id: 'CC0-1.0', path: 'LICENSE.txt' }, dependencies: { 'guide-alias': dependency.reference }, requiredConnections: [], files: Object.entries(payload).map(([path, value]) => ({ path, bytes: value.length, sha256: hash(value) })) as ResourceDescriptor['files'] };
  const definition = bytes(JSON.stringify(descriptor, null, 4) + '\r\n'); const reference: ResourceRef = { id: descriptor.id, revision: descriptor.revision, kind: descriptor.kind, sha256: hash(definition) };
  const resources = { ...guideFiles, ...Object.fromEntries(Object.entries({ ...payload, 'resource.json': definition }).map(([path, value]) => [`resources/skill-alias/${path}`, value])) };
  return { refs: { 'guide-alias': dependency.reference, 'skill-alias': reference }, resources };
}
/** Mutations update the manifest's transport hash so tests reach semantic decoding instead of failing an earlier checksum. */
function replaceFile(archive: Uint8Array, path: string, data: Uint8Array) {
  const files = unzipSync(archive); files[path] = new Uint8Array(data);
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']!));
  const entry = manifest.files.find((item: { path: string }) => item.path === path); if (entry) { entry.bytes = data.length; entry.sha256 = hash(data); }
  files['manifest.json'] = bytes(JSON.stringify(manifest)); return zipSync(files, { level: 0 });
}

describe('byte-preserving authoring source preparation', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('preserves all %s workflow resources and layout without rewriting original identities', async host => {
    const source = materials(), workflow = createBasicWorkflow(); workflow.resources = source.refs; workflow.revision = 9;
    const editor = { format: 'editor-test-v1', positions: { input: { x: 10, y: 20 } }, flowNames: { child: '하위 작업' } };
    const archive = await buildPackage({ workflow, editor, host, resources: source.resources }); const snapshot = await prepareAuthoringImport(archive.bytes);
    expect(snapshot.workflow).toEqual(workflow); expect(snapshot.editor).toEqual(editor); expect(snapshot.source).toMatchObject({ artifactSha256: hash(archive.bytes), host, trust: 'unsigned', kind: 'workflow' });
    expect(snapshot.resourceFiles).toEqual(source.resources); expect(snapshot.resources.find(item => item.alias === 'skill-alias')).toMatchObject({ reference: source.refs['skill-alias'], descriptor: { dependencies: { 'guide-alias': source.refs['guide-alias'] } } });
    expect(snapshot.inventory).toEqual({ resourceCount: 2, fileCount: Object.keys(source.resources).length, bytes: Object.values(source.resources).reduce((sum, value) => sum + value.length, 0) });
    expect(Object.keys(snapshot.resourceFiles).every(path => path.startsWith('resources/'))).toBe(true); expect(snapshot).not.toHaveProperty('copyAuthorized'); expect(snapshot).not.toHaveProperty('published');
    // New authoring identity is a later transactional decision; inspection cannot silently rebrand a signed source.
    const rebuilt = await inspectPackage((await buildPackage({ workflow: snapshot.workflow!, editor: snapshot.editor, resources: snapshot.resourceFiles, host })).bytes);
    for (const [path, original] of Object.entries(source.resources)) expect(rebuilt.files.get(path)).toEqual(original);
  });
  it.each(['codex', 'claude-code', 'opencode'] as const)('preserves %s materials and regenerates identical native Skill assets', async host => {
    const source = materials(); const archive = await buildMaterialsPackage({ host, refs: source.refs, resources: source.resources, name: '본문과 템플릿' });
    const snapshot = await prepareAuthoringImport(archive.bytes); expect(snapshot.workflow).toBeUndefined(); expect(snapshot.source.kind).toBe('materials'); expect(snapshot.resourceFiles).toEqual(source.resources);
    const refs = Object.fromEntries(snapshot.resources.map(item => [item.alias, item.reference]));
    const rebuilt = await inspectPackage((await buildMaterialsPackage({ host, refs, resources: snapshot.resourceFiles, name: '내 자료' })).bytes);
    const root = host === 'codex' ? '.agents' : host === 'claude-code' ? '.claude' : '.opencode';
    expect(rebuilt.files.get(`${root}/skills/original-reading/assets/sample.bin`)).toEqual(source.resources['resources/skill-alias/assets/sample.bin']);
    expect(rebuilt.files.get(`${root}/skills/original-reading/scripts/format.py`)).toEqual(source.resources['resources/skill-alias/scripts/format.py']);
  });
  it('owns source data before an await and keeps returned snapshots independent', async () => {
    const archive = await buildPackage({ workflow: createBasicWorkflow(), host: 'codex', editor: { positions: {} } }); const original = archive.bytes.slice();
    const preparation = prepareAuthoringImport(archive.bytes); archive.bytes.fill(0); const snapshot = await preparation; expect(snapshot.source.artifactSha256).toBe(hash(original));
    snapshot.workflow!.name = '수정'; snapshot.editor!.positions = 'changed'; const fresh = await prepareAuthoringImport(original); expect(fresh.workflow!.name).not.toBe('수정'); expect(fresh.editor).toEqual({ positions: {} });
  });
  it('requires independently trusted signatures when requested but never infers reuse rights', async () => {
    const archive = await buildPackage({ workflow: createBasicWorkflow(), host: 'codex' }); await expect(prepareAuthoringImport(archive.bytes, { requireSignature: true })).rejects.toMatchObject({ code: 'SIGNATURE_REQUIRED' });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519'), files = unzipSync(archive.bytes);
    const signature = sign(null, Buffer.from('AI-WORKFLOW-STUDIO/PACKAGE/1\n' + canonicalize(archive.manifest)), privateKey).toString('base64url');
    files['manifest.sig'] = bytes(JSON.stringify({ algorithm: 'Ed25519', keyId: 'test-authoring', signature })); const signed = zipSync(files);
    await expect(prepareAuthoringImport(signed, { requireSignature: true })).rejects.toMatchObject({ code: 'SIGNATURE_UNTRUSTED' });
    const snapshot = await prepareAuthoringImport(signed, { requireSignature: true, trustStore: { 'test-authoring': publicKey.export({ type: 'spki', format: 'pem' }).toString() } }); expect(snapshot.source.trust).toBe('verified'); expect(snapshot).not.toHaveProperty('copyAuthorized');
  });
  it.each([bytes('null'), bytes('[]'), bytes('{"x":1,"x":2}'), new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]), bytes(JSON.stringify({ content: 'x'.repeat(1024 * 1024) }))])('rejects unusable editor metadata without discarding it %#', async layout => {
    const archive = await buildPackage({ workflow: createBasicWorkflow(), host: 'codex', editor: {} });
    await expect(prepareAuthoringImport(replaceFile(archive.bytes, 'editor.json', layout))).rejects.toMatchObject({ code: 'AUTHORING_EDITOR_INVALID' });
  });
  it('rejects malformed workflow UTF-8 rather than normalizing it to a replacement character', async () => {
    const workflow = createBasicWorkflow('원문 �'); const archive = await buildPackage({ workflow, host: 'codex' }); const files = unzipSync(archive.bytes);
    const text = Buffer.from(files['workflow.json']!); const at = text.indexOf(Buffer.from('�')); expect(at).toBeGreaterThan(0);
    const malformed = Buffer.concat([text.subarray(0, at), Buffer.from([255]), text.subarray(at + 3)]);
    await expect(inspectPackage(replaceFile(archive.bytes, 'workflow.json', malformed))).rejects.toThrow();
  });
  it('rejects extra resource files, removed dependencies and changed native Skill bytes', async () => {
    const source = materials(); const archive = await buildMaterialsPackage({ host: 'codex', refs: source.refs, resources: source.resources, name: '원본' });
    const extra = unzipSync(archive.bytes); extra['resources/skill-alias/extra.txt'] = bytes('unlisted'); await expect(prepareAuthoringImport(zipSync(extra))).rejects.toMatchObject({ code: 'UNLISTED_FILE' });
    const missing = unzipSync(archive.bytes); delete missing['resources/guide-alias/instructions.md']; await expect(prepareAuthoringImport(zipSync(missing))).rejects.toMatchObject({ code: 'FILE_INTEGRITY' });
    const changed = replaceFile(archive.bytes, '.agents/skills/original-reading/assets/record.md', bytes('changed')); await expect(prepareAuthoringImport(changed)).rejects.toMatchObject({ code: 'SKILL_INTEGRITY' });
  });
  it('rejects oversized archive and shared-memory input before copying or decompressing', async () => {
    await expect(prepareAuthoringImport(new Uint8Array(32 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: 'AUTHORING_IMPORT_LIMIT' });
    await expect(prepareAuthoringImport(new Uint8Array(new SharedArrayBuffer(22)))).rejects.toMatchObject({ code: 'AUTHORING_IMPORT_LIMIT' });
  });
});
