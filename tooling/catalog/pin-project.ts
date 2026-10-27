import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseWorkflowJson } from '@studio/spec';
import { collectRequirements } from '@studio/workflow-core';
import { artifactDigest, checkCatalog, digestBytes } from './check.js';
import type { OfficialCatalog } from './inventory.js';
import type { OfficialExample } from './contracts.generated.js';

/** Recover registration after content authoring without overwriting source files or inventing verification evidence. */
const id = process.argv[2]; if (!id || !/^EP-(00[1-9]|0[1-9][0-9]|1[01][0-9]|120)$/.test(id)) throw new Error('Expected an exact EP-001..EP-120 ID');
const root = resolve(import.meta.dirname, '../..'); const catalogPath = resolve(root, 'catalog/official/catalog.json'); const before = await readFile(catalogPath, 'utf8');
const catalog = JSON.parse(before) as OfficialCatalog; const entry = catalog.entries.find(item => item.id === id);
if (!entry || entry.state !== 'planned' || entry.artifact || entry.verificationRecords.length) throw new Error('Only authored content awaiting its first registration may be pinned');
const rootPath = `catalog/official/projects/${id}`; const directory = resolve(root, rootPath);
async function collect(relative = ''): Promise<NonNullable<OfficialExample['artifact']>['files'][number][]> {
  const files: NonNullable<OfficialExample['artifact']>['files'][number][] = [];
  for (const item of await readdir(resolve(directory, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${item.name}` : item.name; const path = resolve(directory, name); const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Project content cannot contain links');
    if (info.isDirectory()) files.push(...await collect(name));
    else if (info.isFile() && info.nlink === 1 && info.size <= 32 * 1024 * 1024) files.push({ path: name, sha256: digestBytes(await readFile(path)), role: name === 'workflow.json' ? 'entrypoint' : name === 'README.md' ? 'readme' : name === 'LICENSE.md' ? 'license' : 'payload' });
    else throw new Error('Unexpected project content type/size');
  }
  return files;
}
const checked = parseWorkflowJson(await readFile(resolve(directory, 'workflow.json'), 'utf8')); if (!checked.valid) throw new Error(JSON.stringify(checked.issues));
const files = await collect() as NonNullable<OfficialExample['artifact']>['files'];
entry.artifact = { rootPath, entrypoint: 'workflow.json', files, sha256: artifactDigest(files) }; entry.state = 'implemented';
entry.requiredCapabilities = [...new Set([...entry.requiredCapabilities, ...collectRequirements(checked.value).capabilities])].sort() as OfficialExample['requiredCapabilities'];
const report = await checkCatalog(catalog, { root }); if (!report.valid) throw new Error(JSON.stringify(report.issues));
if (await readFile(catalogPath, 'utf8') !== before) throw new Error('Catalogue changed while pinning; retry after the other author finishes');
await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
process.stdout.write(`${id} source files pinned as implemented; no actual host/model/official evidence was created.\n`);
