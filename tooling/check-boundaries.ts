import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { findBoundaryViolations } from './boundaries/analyze.js';

/** Dependency checks protect the pure core and keep server-only archive/credential code out of clients. */
async function filesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.filter(e => !['node_modules', 'dist', '.next'].includes(e.name)).map(e => e.isDirectory() ? filesIn(resolve(directory, e.name)) : /\.[cm]?[tj]sx?$/.test(e.name) ? [resolve(directory, e.name)] : []));
  return files.flat();
}
const files = [...await filesIn('apps'), ...await filesIn('packages')];
const sources = await Promise.all(files.map(async file => ({ path: relative(process.cwd(), file).split(sep).join('/'), text: await readFile(file, 'utf8') })));
// A broad build-output ignore rule must never omit required source from the next checkout or CI build.
const ignored = spawnSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], { input: sources.map(source => source.path).join('\0') + '\0', encoding: 'utf8', windowsHide: true });
if (ignored.error || ![0, 1].includes(ignored.status ?? -1)) throw new Error('Could not verify the source inventory against Git ignore rules.');
if (ignored.stdout) throw new Error(`Required source is excluded by Git ignore rules:\n${ignored.stdout.split('\0').filter(Boolean).join('\n')}`);
const workspaceExports: Record<string, string> = {};
for (const name of await readdir('packages')) {
  const manifest = JSON.parse(await readFile(resolve('packages', name, 'package.json'), 'utf8')) as { name: string; exports?: Record<string, string | { default?: string }> };
  for (const [subpath, declaration] of Object.entries(manifest.exports ?? {})) {
    // package-kit is forbidden at every client/pure import site, regardless of its browser error stub.
    const target = typeof declaration === 'string' ? declaration : manifest.name === '@studio/package-kit' ? declaration.default : undefined;
    if (!target) throw new Error(`Boundary analysis needs an explicit resolver for conditional export ${manifest.name}${subpath}`);
    workspaceExports[manifest.name + (subpath === '.' ? '' : subpath.slice(1))] = `packages/${name}/${target.replace(/^\.\//, '')}`;
  }
}
const violations = findBoundaryViolations(sources, workspaceExports);
if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1; }
else console.log('Dependency boundaries passed.');
