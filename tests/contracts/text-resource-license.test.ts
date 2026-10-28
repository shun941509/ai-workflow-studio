import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkedTextResourceLicense, createBasicWorkflow, type TextResourceLicense } from '@studio/spec';
import { buildMaterialsPackage, buildPackage, createTextResource, inspectPackage, prepareAuthoringImport } from '@studio/package-kit';

// These are original fictional authors and bytes. No author declaration is presented as verified publication evidence.
const license: TextResourceLicense = { id: 'MIT', copyrightHolder: '가상 별빛 연구실', copyrightYear: 2026, confirmedAuthority: true };
const id = '4fa55d1b-a602-4d74-8cdc-c3020e09bfe9';
const source = { id, revision: 2, name: '원문 보존 지침', kind: 'instruction' as const, text: '\uFEFF원문의 날짜와 출처를 보존하세요.\r\n없는 내용은 미확인으로 기록하세요.\r\n' };
const encode = (text: string) => new TextEncoder().encode(text);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// Frozen pre-license-selection notice, independently retained from the previous implementation.
const legacyNotice = 'LicenseRef-Proprietary\n개인 작업을 위한 자료입니다. 공개 재배포 권한을 부여하지 않습니다. 별도 허락 없이 다른 사용자에게 배포하지 마세요.\n';
const mitTerms = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

describe('explicit immutable text-resource license contract', () => {
  it('returns an owned declaration without silently normalizing or mutating the author input', () => {
    const input = structuredClone(license), result = checkedTextResourceLicense(input);
    expect(result).toEqual(input); expect(result).not.toBe(input);
    result.copyrightHolder = '다른 가상 저자'; expect(input).toEqual(license);
  });

  const { confirmedAuthority: _authority, ...withoutAuthority } = license;
  it.each([
    ['missing license', undefined], ['null license', null], ['array', []], ['identifier only', { id: 'MIT' }],
    ['missing authority', withoutAuthority], ['false authority', { ...license, confirmedAuthority: false }],
    ['string authority', { ...license, confirmedAuthority: 'true' }], ['other identifier', { ...license, id: 'Apache-2.0' }],
    ['extra key', { ...license, approved: true }], ['empty holder', { ...license, copyrightHolder: '' }],
    ['blank holder', { ...license, copyrightHolder: ' \t ' }], ['leading space', { ...license, copyrightHolder: ' 저자' }],
    ['trailing space', { ...license, copyrightHolder: '저자 ' }], ['newline', { ...license, copyrightHolder: '저자\nMIT' }],
    ['nul', { ...license, copyrightHolder: '저자\u0000' }], ['DEL', { ...license, copyrightHolder: '저자\u007f' }],
    ['unpaired surrogate', { ...license, copyrightHolder: '\ud800' }], ['holder too long', { ...license, copyrightHolder: '가'.repeat(161) }],
    ['year too old', { ...license, copyrightYear: 1899 }], ['year too large', { ...license, copyrightYear: 10000 }],
    ['fractional year', { ...license, copyrightYear: 2026.5 }], ['string year', { ...license, copyrightYear: '2026' }],
  ])('rejects %s without treating it as omitted private terms', (_name, input) => {
    expect(() => checkedTextResourceLicense(input)).toThrow();
    // Runtime callers are unknown before validation; the public materializer must not trust TypeScript casts.
    if (input !== undefined) expect(() => createTextResource({ ...source, license: input as TextResourceLicense })).toThrow();
  });

  it.each([1900, 9999])('accepts the declared inclusive year boundary %i and a 160-character holder', year => {
    expect(checkedTextResourceLicense({ ...license, copyrightYear: year, copyrightHolder: '가'.repeat(160) })).toMatchObject({ copyrightYear: year });
  });

  it('rejects an authority getter before invoking it', () => {
    let reads = 0;
    const input = { ...license, get confirmedAuthority() { reads++; return true; } };
    expect(() => checkedTextResourceLicense(input)).toThrow('Accessors'); expect(reads).toBe(0);
  });

  it.each(['instruction', 'document'] as const)('preserves the complete pre-selection %s bytes and descriptor hash', kind => {
    const material = createTextResource({ ...source, kind });
    const entrypoint = kind === 'instruction' ? 'instructions.md' : 'document.txt';
    const originalDescriptor = {
      schemaVersion: '1.0.0', id, revision: 2, name: source.name, kind, entrypoint,
      license: { id: 'LicenseRef-Proprietary', path: 'LICENSE.txt' }, dependencies: {}, requiredConnections: [],
      files: [
        { path: entrypoint, bytes: encode(source.text).length, sha256: hash(encode(source.text)) },
        { path: 'LICENSE.txt', bytes: encode(legacyNotice).length, sha256: hash(encode(legacyNotice)) },
      ],
    };
    const originalBytes = encode(JSON.stringify(originalDescriptor, null, 2) + '\n');
    expect(material.files).toEqual({ [`resources/${id}/${entrypoint}`]: encode(source.text), [`resources/${id}/LICENSE.txt`]: encode(legacyNotice), [`resources/${id}/resource.json`]: originalBytes });
    expect(material.reference).toEqual({ kind, id, revision: 2, sha256: hash(originalBytes) });
  });

  it('pins the complete MIT notice including author, conditions and disclaimer into the descriptor', () => {
    const material = createTextResource({ ...source, license });
    const notice = encode(`MIT License\n\nCopyright (c) 2026 가상 별빛 연구실\n\n${mitTerms}`);
    expect(material.descriptor.license).toEqual({ id: 'MIT', path: 'LICENSE.txt' });
    expect(material.files[`resources/${id}/LICENSE.txt`]).toEqual(notice);
    expect(material.descriptor.files.find(file => file.path === 'LICENSE.txt')).toEqual({ path: 'LICENSE.txt', bytes: notice.length, sha256: hash(notice) });
    expect(material.reference.sha256).not.toBe(createTextResource(source).reference.sha256);
    expect(material.files[`resources/${id}/instructions.md`]).toEqual(encode(source.text));
  });

  it('rejects a changed notice even when the body and ResourceRef are unchanged', async () => {
    const material = createTextResource({ ...source, license });
    const resources = { ...material.files, [`resources/${id}/LICENSE.txt`]: encode('MIT') };
    await expect(buildMaterialsPackage({ host: 'codex', name: source.name, refs: { [id]: material.reference }, resources })).rejects.toMatchObject({ code: 'RESOURCE_INTEGRITY' });
  });

  // Inspect and prepare real ZIP bytes. Re-export preserves resource originals, not volatile package IDs/timestamps.
  for (const kind of ['materials', 'workflow'] as const) {
    it.each(['codex', 'claude-code', 'opencode'] as const)(`preserves MIT and private bytes through ${kind} %s export and re-import`, async host => {
      const shared = createTextResource({ ...source, license });
      const privateMaterial = createTextResource({ ...source, id: 'private-guide' });
      const refs = { [id]: shared.reference, 'private-guide': privateMaterial.reference };
      const resources = { ...shared.files, ...privateMaterial.files };
      const workflow = createBasicWorkflow('자료 이용 조건 보존'); workflow.resources = refs;
      const archive = kind === 'materials'
        ? await buildMaterialsPackage({ host, refs, resources, name: '원본 자료' })
        : await buildPackage({ host, workflow, resources });
      const inspected = await inspectPackage(archive.bytes), imported = await prepareAuthoringImport(archive.bytes);
      expect(inspected.trust).toBe('unsigned'); expect(inspected.manifest.compatibility.host.verification).toBe('unverified');
      expect(imported.resourceFiles).toEqual(resources); expect(imported).not.toHaveProperty('copyAuthorized');
      const rebuilt = kind === 'materials'
        ? await buildMaterialsPackage({ host, refs: Object.fromEntries(imported.resources.map(item => [item.alias, item.reference])), resources: imported.resourceFiles, name: '다시 가져온 자료' })
        : await buildPackage({ host, workflow: imported.workflow!, resources: imported.resourceFiles });
      const again = await inspectPackage(rebuilt.bytes);
      for (const [path, bytes] of Object.entries(resources)) {
        expect(again.files.get(path)).toEqual(bytes);
        expect(again.manifest.files.find(file => file.path === path)).toMatchObject({ bytes: bytes.length, sha256: hash(bytes) });
      }
      expect(again.manifest.resources).toEqual(refs);
    });
  }
});
