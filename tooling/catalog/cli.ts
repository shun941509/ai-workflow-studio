import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '@studio/spec';
import { checkCatalog } from './check.js';

/** Integrity checks may pass for a planned inventory; --release separately enforces actual 120+120 publication. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const argument = (name: string) => { const index = args.indexOf(name); if (index < 0) return undefined; if (!args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error(`Missing value for ${name}`); return args[index + 1]!; };
const inventoryPath = argument('--catalog') ?? 'catalog/official/catalog.json';
const trustPath = argument('--trusted-keys');
const capabilityPath = argument('--capabilities');
const readJson = async (target: string) => parseStrictJson(await readFile(path.resolve(root, target), 'utf8'));
const trust = trustPath ? await readJson(trustPath) : {};
if (!trust || typeof trust !== 'object' || Array.isArray(trust) || Object.values(trust).some((key) => typeof key !== 'string')) throw new Error('Trusted keys must be an operator-owned key ID to PEM map.');
const capabilities = capabilityPath ? await readJson(capabilityPath) : undefined;
if (capabilities !== undefined && (!Array.isArray(capabilities) || capabilities.some((capability) => typeof capability !== 'string'))) throw new Error('Capabilities must be a verified release capability list.');
const report = await checkCatalog(await readJson(inventoryPath), { root, trustedVerifierKeys: trust as Record<string, string>, ...(capabilities ? { availableCapabilities: capabilities as string[] } : {}) });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.valid || args.includes('--release') && !report.releaseReady) process.exitCode = 1;
