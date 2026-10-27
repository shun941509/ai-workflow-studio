import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseStrictJson } from '@studio/spec';
import { checkCatalog } from '../catalog/check.js';
import { checkReleaseGates, RELEASE_CHECKS, type ReleaseTrust, type ReleaseEvidence } from './check-gates.js';

/** Release checks never create evidence, sign files or publish anything. Missing prerequisites fail closed. */
const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); if (index < 0) return undefined; const value = args[index + 1]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`); return value; };
const required = ['--evidence', '--trusted-keys', '--source-archive', '--runner-archive', '--web-archive', '--report-root'] as const;
const missingInputs = required.filter(name => !option(name));
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
async function boundedFile(filename: string, max = 16 * 1024 * 1024): Promise<Uint8Array> {
  const target = path.resolve(filename); const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > max) throw new Error('Release file type or size is invalid.');
  const data = await readFile(target); if (data.length !== info.size) throw new Error('Release file changed while reading.'); return data;
}
const json = (bytes: Uint8Array): unknown => parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const catalogueBytes = await boundedFile('catalog/official/catalog.json');
let trust: Record<string, ReleaseTrust> = {};
let bundle: { releaseId: string; records: ReleaseEvidence[]; capabilities: string[] } | undefined;
if (!missingInputs.length) {
  const candidate = json(await boundedFile(option('--trusted-keys')!));
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Operator-owned trusted keys are required.');
  for (const [key, value] of Object.entries(candidate)) {
    if (!value || typeof value !== 'object' || typeof value.publicKey !== 'string' || !Array.isArray(value.gates) || value.gates.some((gate: unknown) => typeof gate !== 'string' || gate !== 'catalog' && !Object.hasOwn(RELEASE_CHECKS, gate))) throw new Error('Invalid verifier key scope.');
    trust[key] = value as ReleaseTrust;
  }
  const candidateBundle = json(await boundedFile(option('--evidence')!)) as typeof bundle;
  if (!candidateBundle || typeof candidateBundle.releaseId !== 'string' || !Array.isArray(candidateBundle.records) || !Array.isArray(candidateBundle.capabilities) || candidateBundle.capabilities.some(value => typeof value !== 'string')) throw new Error('Expected releaseId, records and capabilities.');
  bundle = candidateBundle;
}
const catalogKeys = Object.fromEntries(Object.entries(trust).filter(([, key]) => key.gates.includes('catalog')).map(([id, key]) => [id, key.publicKey]));
const catalog = await checkCatalog(json(catalogueBytes), { root: process.cwd(), trustedVerifierKeys: catalogKeys, ...(bundle ? { availableCapabilities: bundle.capabilities } : {}) });
if (!bundle) {
  process.stdout.write(JSON.stringify({ valid: catalog.valid, releaseReady: false, missingInputs, missingGates: Object.keys(RELEASE_CHECKS), catalog }, null, 2) + '\n');
  process.exitCode = 1;
} else {
  const subject = {
    sourceSha256: sha(await boundedFile(option('--source-archive')!, 512 * 1024 * 1024)),
    runnerSha256: sha(await boundedFile(option('--runner-archive')!, 512 * 1024 * 1024)),
    webSha256: sha(await boundedFile(option('--web-archive')!, 512 * 1024 * 1024)), catalogSha256: sha(catalogueBytes),
  };
  const reports = new Map<string, Uint8Array>(); const root = await realpath(option('--report-root')!);
  for (const record of bundle.records) for (const report of Array.isArray(record?.reports) ? record.reports : []) {
    if (typeof report.path !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(report.path) || report.path.split('/').some(part => !part || part === '.' || part === '..')) continue;
    const target = path.resolve(root, report.path); const actual = await realpath(target); const relation = path.relative(root, actual);
    if (path.isAbsolute(relation) || relation.startsWith('..') || actual !== target) throw new Error('Report escapes the verified directory.');
    reports.set(report.path, await boundedFile(target));
  }
  const report = checkReleaseGates({ releaseId: bundle.releaseId, subject, evidence: bundle.records, trustedKeys: trust, reportBytes: reports, catalog });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n'); if (!report.releaseReady) process.exitCode = 1;
}
