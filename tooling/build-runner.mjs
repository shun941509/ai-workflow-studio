import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Build a self-contained local release candidate without changing the user's installed runtime or PATH. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platform = `${process.platform}-${process.arch}`;
if (platform !== 'win32-x64' || process.version !== 'v24.22.1') throw new Error('검증 대상으로 고정한 Windows x64 Node 24.22.1에서 빌드하세요.');
const output = join(root, 'artifacts', 'runner', platform, new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
await stat(join(root, 'apps', 'runner-ui', 'dist', 'index.html'));
const options = {
  absWorkingDir: root, bundle: true, platform: 'node', target: 'node24', format: 'esm',
  packages: 'bundle', sourcemap: false, legalComments: 'external',
  // Bundled CommonJS dependencies still need a Node require for built-in modules.
  banner: { js: "import { createRequire as __studioCreateRequire } from 'node:module'; const require = __studioCreateRequire(import.meta.url);" },
};
await build({ ...options, entryPoints: ['apps/runner/src/cli/main.ts'], outfile: join(output, 'runner.mjs') });
await build({ ...options, entryPoints: ['apps/runner/src/mcp/bridge.ts'], outfile: join(output, 'bridge.mjs') });
await cp(process.execPath, join(output, 'node.exe'));
await cp(join(dirname(process.execPath), 'LICENSE'), join(output, 'NODE-LICENSE.txt'));
await cp(join(root, 'apps', 'runner-ui', 'dist'), join(output, 'ui'), { recursive: true, errorOnExist: true });
await writeFile(join(output, 'studio-runner.cmd'), '@echo off\r\nrem Launch the bundled runtime and built UI; no package installation occurs.\r\n"%~dp0node.exe" "%~dp0runner.mjs" --ui-dir "%~dp0ui" %*\r\n');
await writeFile(join(output, 'studio-bridge.cmd'), '@echo off\r\nrem Relay MCP calls to the independent Studio Runner daemon.\r\n"%~dp0node.exe" "%~dp0bridge.mjs" %*\r\n');
await writeFile(join(output, 'README.ko.md'), '# Studio Runner 배포 후보\n\n고정된 Node 런타임과 빌드된 UI가 포함되어 있습니다. studio-runner.cmd로 실행합니다.\n이 산출물은 내부 설치 검증용이며 아직 공식 서명·업데이트 검증을 통과한 배포본이 아닙니다. 사용자 다운로드 페이지에 게시하지 않습니다.\n프로젝트 ZIP에는 이 런타임이나 개발 의존성을 넣지 않습니다.\n');
const inventory = [];
async function walk(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) await walk(path);
    else {
      const bytes = await readFile(path);
      inventory.push({ path: relative(output, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
}
await walk(output);
await writeFile(join(output, 'build-manifest.json'), JSON.stringify({ version: '0.1.0', node: process.version, platform, distribution: 'internal-candidate', signed: false, files: inventory }, null, 2) + '\n');
process.stdout.write(output + '\n');
