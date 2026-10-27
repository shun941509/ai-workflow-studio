import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';
import { buildMaterialsPackage, inspectPackage, verifyResources, type ResourceDescriptor } from '@studio/package-kit';
import type { ResourceRef } from '@studio/spec';
import { checkCatalog } from '../../tooling/catalog/check.js';
import type { OfficialCatalog } from '../../tooling/catalog/inventory.js';

const root = process.cwd();
const catalogPath = path.join(root, 'catalog/official/catalog.json');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as OfficialCatalog;
const ids = Array.from({ length: 30 }, (_, index) => `ER-${String(index + 11).padStart(3, '0')}`);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** These checks validate authored content and archive construction, never claim a model or host actually used it. */
describe('original instruction resources ER-011 through ER-040', () => {
  test.each(ids)('%s provides concrete procedures, templates, fictional examples and intact operational ZIPs for three hosts', async (id) => {
    const entry = catalog.entries.find((candidate) => candidate.id === id)!;
    expect(entry.state).toBe('implemented'); expect(entry.resourceKind).toBe('instruction');
    expect(entry.verificationRecords).toEqual([]); expect(entry.review).toBeUndefined();
    const directory = path.join(root, entry.artifact!.rootPath);
    const descriptorBytes = new Uint8Array(await readFile(path.join(directory, 'resource.json')));
    const descriptor = JSON.parse(decode(descriptorBytes)) as ResourceDescriptor;
    expect(descriptor.entrypoint).toBe('instructions.md'); expect(descriptor.revision).toBe(1);
    expect(descriptor.license).toEqual({ id: 'LicenseRef-Studio-Examples-v1', path: 'LICENSE.md' });
    const reference: ResourceRef = { id, revision: descriptor.revision, kind: 'instruction', sha256: hash(descriptorBytes) };
    const files = new Map<string, Uint8Array>([[`resources/${id}/resource.json`, descriptorBytes]]);
    for (const file of descriptor.files) {
      const bytes = new Uint8Array(await readFile(path.join(directory, file.path)));
      expect(hash(bytes)).toBe(file.sha256); expect(bytes.length).toBe(file.bytes);
      files.set(`resources/${id}/${file.path}`, bytes);
    }
    expect(verifyResources({ [id]: reference }, files).get(id)?.id).toBe(id);
    const instruction = decode(files.get(`resources/${id}/instructions.md`)!);
    const template = decode(files.get(`resources/${id}/templates/result.md`)!);
    const usage = decode(files.get(`resources/${id}/examples/usage.md`)!);
    const license = decode(files.get(`resources/${id}/LICENSE.md`)!);
    expect(instruction).toContain(entry.definition.purpose); expect(instruction).toContain(entry.definition.acceptanceCriteria);
    expect(instruction.match(/^\d+\. /gm)?.length).toBeGreaterThanOrEqual(5);
    expect(instruction).toContain('필수 입력'); expect(instruction).toContain('금지·실패·미확인 처리');
    expect(template.match(/^## /gm)?.length).toBeGreaterThanOrEqual(5);
    expect(usage).toContain('가상 연습자료'); expect(usage).toContain('실제 모델·외부 서비스 실행 기록이 아닙니다');
    expect(usage).toContain('입력이 부족하거나 충돌할 때');
    expect(license).toContain('사용, 복제, 수정, 결합 및 재배포를 허용'); expect(license).toContain('제3자의 자료나 권리를 포함하지 않습니다');
    expect((await readdir(directory)).sort()).toEqual(['LICENSE.md', 'README.md', 'examples', 'instructions.md', 'resource.json', 'templates']);
    for (const host of ['codex', 'claude-code', 'opencode'] as const) {
      const built = await buildMaterialsPackage({ host, refs: { [id]: reference }, resources: Object.fromEntries(files), name: entry.name });
      const inspected = await inspectPackage(built.bytes);
      expect(inspected.manifest.packageKind).toBe('materials'); expect(inspected.manifest.purpose).toBe('production');
      expect(inspected.manifest.compatibility.host.verification).toBe('unverified');
      const unzipped = unzipSync(built.bytes);
      // Independent byte comparison prevents a regenerated or truncated instruction from masquerading as the source.
      expect(hash(unzipped[`resources/${id}/instructions.md`]!)).toBe(hash(files.get(`resources/${id}/instructions.md`)!));
      expect(unzipped[host === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md']).toBeDefined();
      expect(Object.keys(unzipped).some((name) => /(?:^|\/)(?:tests|fixtures|node_modules)(?:\/|$)|verification\.spec|materialize-instructions/.test(name))).toBe(false);
    }
  });

  test('all thirty operational procedures are distinct and do not count as verified releases', async () => {
    const procedures = await Promise.all(ids.map(async (id) => {
      const text = await readFile(path.join(root, `catalog/official/resources/${id}/instructions.md`), 'utf8');
      return text.split('## 작업 절차\n\n')[1]!.split('\n## 결과 계약')[0]!.replace(/\s+/g, ' ').trim();
    }));
    expect(new Set(procedures).size).toBe(30);
    // Matching names would not catch renamed filler; pairwise instruction vocabulary must meaningfully differ.
    const words = procedures.map((text) => new Set(text.split(/\s+/).filter((word) => word.length > 2)));
    for (let left = 0; left < words.length; left++) for (let right = left + 1; right < words.length; right++) {
      const common = [...words[left]!].filter((word) => words[right]!.has(word)).length;
      const union = new Set([...words[left]!, ...words[right]!]).size;
      expect(common / union).toBeLessThan(0.55);
    }
    const report = await checkCatalog(catalog, { root });
    expect(report.issues).toEqual([]); expect(report.releaseReady).toBe(false);
    expect(catalog.entries.filter((entry) => ids.includes(entry.id) && entry.state === 'implemented')).toHaveLength(30);
    expect(report.counts.usableResources).toBe(0); expect(report.counts.publishedResources).toBe(0); expect(report.counts.verifiedHostCombinations).toBe(0);
  });

  test('rerunning the initial authoring tool refuses to overwrite authored source files or the inventory', async () => {
    const sample = path.join(root, 'catalog/official/resources/ER-011/instructions.md');
    const before = hash(await readFile(sample)); const inventoryBefore = hash(await readFile(catalogPath));
    await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', 'tooling/catalog/materialize-instructions.ts'], { cwd: root })).rejects.toMatchObject({ stderr: expect.stringContaining('refusing to overwrite') });
    expect(hash(await readFile(sample))).toBe(before); expect(hash(await readFile(catalogPath))).toBe(inventoryBefore);
  });
});
