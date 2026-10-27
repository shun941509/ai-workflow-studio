import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Development-only launcher: use the project runtime without changing the user's global PATH or broken shim. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, '.tools', 'node', 'node-v24.22.1-win-x64');
const env = { ...process.env, PATH: existsSync(join(runtime, 'node.exe')) ? runtime + delimiter + process.env.PATH : process.env.PATH };
let command = 'pnpm';
if (process.platform === 'win32') {
  const paths = (process.env.PATH ?? '').split(delimiter);
  const candidates = paths.flatMap(path => [join(path, 'pnpm.exe'), join(path, 'node_modules', 'pnpm', 'node_modules', '@pnpm', 'exe.win32-x64', 'pnpm.exe')]);
  command = candidates.find(existsSync) ?? '';
  if (!command) throw new Error('pnpm 네이티브 실행 파일이 필요합니다. pnpm 12 설치 상태를 확인하세요.');
  env.PATH = dirname(command) + delimiter + env.PATH;
}
const result = spawnSync(command, process.argv.slice(2), { cwd: root, env, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
