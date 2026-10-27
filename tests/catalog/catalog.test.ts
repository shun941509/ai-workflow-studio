import { afterEach, describe, expect, test } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalize } from 'json-canonicalize';
import { artifactDigest, checkCatalog, definitionDigest, digestBytes, unsignedVerification, type CatalogOptions } from '../../tooling/catalog/check.js';
import { parseOfficialBrief, sourceIdentity, type OfficialCatalog } from '../../tooling/catalog/inventory.js';
import type { OfficialExample, VerificationRecord } from '../../tooling/catalog/contracts.generated.js';

const repository = process.cwd();
const catalog = JSON.parse(await readFile(path.join(repository, 'catalog/official/catalog.json'), 'utf8')) as OfficialCatalog;
const temporaryRoots: string[] = [];
const now = new Date('2026-10-28T03:00:00.000Z');
const hosts = ['codex', 'claude-code', 'opencode'] as const;
const bytes = (text: string) => new TextEncoder().encode(text);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const testKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const wrap = (entries: OfficialExample[]): OfficialCatalog => ({ schemaVersion: '1.0.0', releaseTargets: { projects: 120, resources: 120 }, entries });

afterEach(async () => {
  // Test fixtures are confined to verified mkdtemp roots, never any product or user content directory.
  for (const root of temporaryRoots.splice(0)) {
    const resolved = path.resolve(root); const allowed = path.resolve(tmpdir());
    if (!resolved.startsWith(`${allowed}${path.sep}studio-catalog-test-`)) throw new Error('Unsafe test cleanup path.');
    await rm(resolved, { recursive: true, force: true });
  }
});

/** Synthetic attestations test the gate only. These temporary keys and files are never official evidence. */
async function fixture(id = 'ER-012', root?: string) {
  if (!root) { root = await mkdtemp(path.join(tmpdir(), 'studio-catalog-test-')); temporaryRoots.push(root); }
  const entry = structuredClone(catalog.entries.find((item) => item.id === id)!);
  entry.state = 'published'; const directory = `content/${entry.id}`;
  const payloads = new Map<string, Uint8Array>([
    ['README.md', bytes(`# ${entry.name}\nThis is a temporary gate-test fixture, not an official release.\n`)],
    ['LICENSE', bytes('CC0-1.0 — test fixture only.\n')],
    ['instruction.md', bytes('Identify the task, its observable output, and an explicit check for completion.\n')],
  ]);
  const descriptor = { schemaVersion: '1.0.0', id: entry.id, revision: 1, kind: entry.resourceKind, name: entry.name, entrypoint: 'instruction.md', license: { id: 'CC0-1.0', path: 'LICENSE' }, dependencies: {}, requiredConnections: entry.externalDependencies.map((dependency) => dependency.id), files: [...payloads].map(([name, content]) => ({ path: name, bytes: content.length, sha256: digestBytes(content) })) };
  payloads.set('resource.json', bytes(JSON.stringify(descriptor)));
  await mkdir(path.join(root, directory), { recursive: true });
  for (const [name, content] of payloads) await writeFile(path.join(root, directory, name), content);
  const files = [...payloads].map(([name, content]) => ({ path: name, sha256: digestBytes(content), role: name === 'resource.json' ? 'entrypoint' : name === 'README.md' ? 'readme' : name === 'LICENSE' ? 'license' : 'payload' })) as NonNullable<OfficialExample['artifact']>['files'];
  entry.artifact = { rootPath: directory, entrypoint: 'resource.json', sha256: artifactDigest(files), files };
  entry.review = { reviewerId: 'test-reviewer', reviewedAt: now.toISOString(), artifactSha256: entry.artifact.sha256, distinctPurposeConfirmed: true };
  await mkdir(path.join(root, 'evidence', entry.id), { recursive: true });
  const records: VerificationRecord[] = [];
  for (const host of hosts) {
    const evidencePath = `evidence/${entry.id}/${host}.log`;
    const evidence = bytes(`Synthetic ${host} acceptance trace for a test-only signing key. This is not a real model run.\n`);
    await writeFile(path.join(root, evidencePath), evidence);
    records.push({ schemaVersion: '1.0.0', id: `${entry.id}-${host}`, exampleId: entry.id, artifactSha256: entry.artifact.sha256, definitionSha256: definitionDigest(entry), mode: 'real', mocked: false, status: 'passed', host, hostVersion: '1.0.0', runnerVersion: '0.1.0', startedAt: '2026-10-28T02:58:00.000Z', finishedAt: '2026-10-28T02:59:00.000Z', capabilities: entry.requiredCapabilities, acceptanceCriteria: entry.definition.acceptanceCriteria, steps: [ { kind: 'host-entry', passed: true, evidencePath }, { kind: 'resource-use', passed: true, evidencePath }, { kind: 'acceptance-check', passed: true, evidencePath } ], dependencies: entry.externalDependencies.map((dependency) => ({ id: dependency.id, mode: 'actual', version: 'test-contract-1', evidencePath })), evidence: [{ path: evidencePath, sha256: digestBytes(evidence) }], signature: { algorithm: 'Ed25519', keyId: 'temporary-test-verifier', value: 'pending' } });
  }
  const saveRecords = async () => {
    entry.verificationRecords = [];
    for (const record of records) {
      record.signature.value = sign(null, Buffer.from(canonicalize(unsignedVerification(record))), privateKey).toString('base64');
      const target = `evidence/${entry.id}/${record.host}.json`; const content = bytes(JSON.stringify(record));
      await writeFile(path.join(root!, target), content); entry.verificationRecords.push({ path: target, sha256: digestBytes(content) });
    }
  };
  await saveRecords();
  const options: CatalogOptions = { root, trustedVerifierKeys: { 'temporary-test-verifier': testKey }, availableCapabilities: entry.requiredCapabilities, requireCompleteInventory: false, now };
  return { root, entry, records, options, saveRecords };
}

describe('official example inventory', () => {
  test('preserves all 240 exact approved briefs and excludes unverified planned or implemented items from release totals', async () => {
    const source = parseOfficialBrief(await readFile(path.join(repository, 'docs/specifications/official-catalog-design.md'), 'utf8'));
    expect(catalog.entries.map(sourceIdentity)).toEqual(source.map(sourceIdentity));
    expect(catalog.entries).toHaveLength(240); expect(new Set(catalog.entries.map((entry) => entry.id)).size).toBe(240);
    expect(catalog.entries.filter((entry) => entry.resourceKind === 'mcp')).toHaveLength(10);
    expect(catalog.entries.filter((entry) => entry.resourceKind === 'instruction')).toHaveLength(30);
    expect(catalog.entries.filter((entry) => entry.resourceKind === 'document')).toHaveLength(20);
    expect(catalog.entries.filter((entry) => entry.resourceKind === 'skill')).toHaveLength(60);
    const report = await checkCatalog(catalog, { root: repository });
    expect(report.valid).toBe(true); expect(report.releaseReady).toBe(false);
    expect(report.counts).toEqual({ plannedProjects: catalog.entries.filter((entry) => entry.kind === 'project' && entry.state === 'planned').length, plannedResources: catalog.entries.filter((entry) => entry.kind === 'resource' && entry.state === 'planned').length, usableProjects: 0, usableResources: 0, publishedProjects: 0, publishedResources: 0, verifiedHostCombinations: 0 });
    expect(report.releaseGaps).toHaveLength(3);
  });

  test.each(['duplicate-id', 'removed-external-dependency', 'source-change', 'claimed-complete'] as const)('rejects %s without producing a usable item', async (scenario) => {
    const entry = structuredClone(catalog.entries[0]!); let entries = [entry];
    if (scenario === 'duplicate-id') entries = [entry, structuredClone(entry)];
    if (scenario === 'removed-external-dependency') entry.externalDependencies = [];
    if (scenario === 'source-change') entry.definition.purpose = 'Changed purpose';
    if (scenario === 'claimed-complete') entry.state = 'verified';
    const report = await checkCatalog(wrap(entries), { root: repository, requireCompleteInventory: false });
    expect(report.valid).toBe(false); expect(report.releaseReady).toBe(false); expect(report.counts.usableProjects).toBe(0);
  });
});

describe('signed actual-use acceptance boundary', () => {
  test('accepts complete test-key evidence but does not confuse one resource with release readiness', async () => {
    const item = await fixture(); const report = await checkCatalog(wrap([item.entry]), item.options);
    expect(report.issues).toEqual([]); expect(report.counts.usableResources).toBe(1); expect(report.counts.publishedResources).toBe(1);
    expect(report.releaseReady).toBe(false); expect(report.counts.verifiedHostCombinations).toBe(0);
  });

  test.each(['untrusted-key', 'forged-signature', 'mocked-run', 'missing-service-receipt', 'missing-host', 'unavailable-capability', 'stale-evidence', 'wrong-artifact', 'unpinned-step'] as const)('rejects %s and excludes it from release totals', async (scenario) => {
    const item = await fixture(); const first = item.records[0]!;
    if (scenario === 'untrusted-key') item.options.trustedVerifierKeys = {};
    if (scenario === 'mocked-run') (first as unknown as { mocked: boolean }).mocked = true;
    if (scenario === 'missing-service-receipt') first.dependencies = [];
    if (scenario === 'missing-host') item.records.pop();
    if (scenario === 'unavailable-capability') item.options.availableCapabilities = [];
    if (scenario === 'stale-evidence') { first.startedAt = '2025-01-01T00:00:00.000Z'; first.finishedAt = '2025-01-01T00:01:00.000Z'; }
    if (scenario === 'wrong-artifact') first.artifactSha256 = '0'.repeat(64);
    if (scenario === 'unpinned-step') first.steps[0].evidencePath = 'evidence/not-pinned.log';
    await item.saveRecords();
    if (scenario === 'forged-signature') {
      first.signature.value = Buffer.alloc(64, 1).toString('base64');
      const content = bytes(JSON.stringify(first)); const target = item.entry.verificationRecords[0]!;
      await writeFile(path.join(item.root, target.path), content); target.sha256 = digestBytes(content);
    }
    const report = await checkCatalog(wrap([item.entry]), item.options);
    expect(report.valid).toBe(false); expect(report.counts.usableResources).toBe(0); expect(report.counts.publishedResources).toBe(0);
  });

  test.each(['artifact-bytes', 'evidence-bytes', 'unlisted-payload', 'path-traversal'] as const)('rejects %s tampering', async (scenario) => {
    const item = await fixture();
    if (scenario === 'artifact-bytes') await writeFile(path.join(item.root, item.entry.artifact!.rootPath, 'instruction.md'), 'Changed instruction');
    if (scenario === 'evidence-bytes') await writeFile(path.join(item.root, item.records[0]!.evidence[0].path), 'Changed evidence');
    if (scenario === 'unlisted-payload') await writeFile(path.join(item.root, item.entry.artifact!.rootPath, 'hidden.txt'), 'Unlisted data');
    if (scenario === 'path-traversal') { item.entry.artifact!.rootPath = '../outside'; }
    const report = await checkCatalog(wrap([item.entry]), item.options);
    expect(report.valid).toBe(false); expect(report.counts.usableResources).toBe(0);
  });

  test('does not double count the same instruction with a different name, README and official identity', async () => {
    const first = await fixture('ER-012'); const second = await fixture('ER-018', first.root);
    const report = await checkCatalog(wrap([first.entry, second.entry]), first.options);
    expect(report.issues.filter((issue) => issue.code === 'DUPLICATE_CONTENT')).toHaveLength(2);
    expect(report.counts.usableResources).toBe(0); expect(report.counts.publishedResources).toBe(0);
  });
});
