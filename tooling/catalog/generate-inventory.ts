import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOfficialBrief, sourceIdentity, type OfficialCatalog } from './inventory.js';

/** Bootstrap only; existing implementation and verification records are never overwritten by generation. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entries = parseOfficialBrief(await readFile(path.join(root, 'docs/specifications/official-catalog-design.md'), 'utf8'));
if (entries.length !== 240 || new Set(entries.map((entry) => entry.id)).size !== 240) throw new Error('The approved source must contain exactly 240 distinct entries.');
const target = path.join(root, 'catalog/official/catalog.json');
if (process.argv.includes('--check')) {
  const catalog = JSON.parse(await readFile(target, 'utf8')) as OfficialCatalog;
  if (JSON.stringify(catalog.entries.map(sourceIdentity)) !== JSON.stringify(entries.map(sourceIdentity))) throw new Error('Catalogue differs from the approved 240-item brief.');
  process.stdout.write('All 240 catalogue briefs match the agreed source.\n');
} else {
  await mkdir(path.dirname(target), { recursive: true });
  const catalog: OfficialCatalog = { schemaVersion: '1.0.0', releaseTargets: { projects: 120, resources: 120 }, entries };
  await writeFile(target, `${JSON.stringify(catalog, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write('Created 240 planned briefs. Usable: 0. Published: 0.\n');
}
