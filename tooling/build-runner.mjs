import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNoticeInventory, verifyNoticeInventory } from './distribution/notice-inventory.ts';

/** Build a self-contained local release candidate without changing the user's installed runtime or PATH. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platform = `${process.platform}-${process.arch}`;
if (platform !== 'win32-x64' || process.version !== 'v24.22.1') throw new Error('검증 대상으로 고정한 Windows x64 Node 24.22.1에서 빌드하세요.');
const output = join(root, 'artifacts', 'runner', platform, new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
await stat(join(root, 'apps', 'runner-ui', 'dist', 'index.html'));
const options = {
  absWorkingDir: root, bundle: true, platform: 'node', target: 'node24', format: 'esm',
  packages: 'bundle', sourcemap: false, legalComments: 'external', metafile: true,
  // Bundled CommonJS dependencies still need a Node require for built-in modules.
  banner: { js: "import { createRequire as __studioCreateRequire } from 'node:module'; const require = __studioCreateRequire(import.meta.url);" },
};
const bundleInventories = [];
/** Snapshot the same bytes given to esbuild; a later source edit cannot rewrite the provenance of this bundle. */
async function productionBundle(scope, entrypoint, filename) {
  const inputs = new Map(); const loaders = { '.js': 'js', '.cjs': 'js', '.mjs': 'js', '.ts': 'ts', '.cts': 'ts', '.mts': 'ts', '.tsx': 'tsx', '.jsx': 'jsx', '.json': 'json', '.css': 'css', '.txt': 'text' };
  const built = await build({ ...options, entryPoints: [entrypoint], outfile: join(output, filename), plugins: [{ name: 'studio-input-provenance', setup(builder) { builder.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => { const contents = await readFile(args.path); const loader = loaders[extname(args.path)]; if (!loader) throw new Error('Unsupported production input type.'); inputs.set(resolve(args.path), contents); return { contents, loader, resolveDir: dirname(args.path) }; }); } }] });
  const retained = new Set(); for (const emitted of Object.values(built.metafile.outputs)) for (const [id, metadata] of Object.entries(emitted.inputs)) if (metadata.bytesInOutput > 0) retained.add(id);
  const notices = await collectNoticeInventory({ workspaceRoot: root, scope, inputs: [...retained].map((id) => ({ id: resolve(root, id), contents: inputs.get(resolve(root, id)) })) });
  for (const [path, bytes] of notices.assets) { const target = join(output, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); }
  bundleInventories.push({ scope, inventoryPath: `notices/${scope}/inventory.json`, inventory: notices.inventory, bundlePath: filename, bundleSha256: createHash('sha256').update(await readFile(join(output, filename))).digest('hex') });
}
await productionBundle('runner', 'apps/runner/src/cli/main.ts', 'runner.mjs');
await productionBundle('bridge', 'apps/runner/src/mcp/bridge.ts', 'bridge.mjs');
await cp(process.execPath, join(output, 'node.exe'));
await cp(join(dirname(process.execPath), 'LICENSE'), join(output, 'NODE-LICENSE.txt'));
// The user selected MIT for first-party code; ship its exact notice separately from dependency/vendor terms.
await cp(join(root, 'LICENSE'), join(output, 'LICENSE'));
/** An old or manually changed UI dist cannot smuggle a dependency tree, hidden configuration or tests into the release. */
async function checkUiFiles(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'tests' || /\.(?:map|test\.[a-z]+|spec\.[a-z]+)$/i.test(entry.name)) throw new Error('Unsupported file in production UI distribution.');
    if (!prefix && path !== 'index.html' && path !== 'assets' && path !== 'notices') throw new Error('Unexpected production UI root file.');
    if (entry.isDirectory()) await checkUiFiles(join(directory, entry.name), path); else if (!entry.isFile()) throw new Error('Unsupported production UI entry.');
  }
}
await checkUiFiles(join(root, 'apps', 'runner-ui', 'dist'));
await cp(join(root, 'apps', 'runner-ui', 'dist'), join(output, 'ui'), { recursive: true, errorOnExist: true });
const uiInventoryPath = 'ui/notices/runner-ui/inventory.json';
const uiInventory = JSON.parse(await readFile(join(output, uiInventoryPath), 'utf8'));
if (uiInventory.schemaVersion !== '1.0.0' || uiInventory.scope !== 'runner-ui' || !Array.isArray(uiInventory.components) || !Array.isArray(uiInventory.gaps)) throw new Error('Runner UI production notice inventory is missing or invalid.');
await verifyNoticeInventory(uiInventory, (path) => readFile(join(output, 'ui', path)));
// The runtime vendor LICENSE remains byte-for-byte intact and is represented independently of npm packages.
const nodeLicense = await readFile(join(output, 'NODE-LICENSE.txt')); const nodeBinary = await readFile(join(output, 'node.exe'));
const studioLicense = await readFile(join(output, 'LICENSE'));
const noticeComplete = bundleInventories.every((item) => item.inventory.noticeComplete) && uiInventory.noticeComplete === true;
const sbom = { schemaVersion: '1.0.0', format: 'studio-distribution-inputs', releaseApproved: false, noticeComplete,
  project: { name: 'AI Workflow Studio', declaredLicense: 'MIT', notice: { path: 'LICENSE', bytes: studioLicense.length, sha256: createHash('sha256').update(studioLicense).digest('hex') } },
  runtime: { name: 'node', version: process.version.slice(1), platform, declaredLicense: null, licenseDeclarationSource: 'vendor LICENSE reproduced without legal classification', binary: { path: 'node.exe', bytes: nodeBinary.length, sha256: createHash('sha256').update(nodeBinary).digest('hex') }, notice: { path: 'NODE-LICENSE.txt', bytes: nodeLicense.length, sha256: createHash('sha256').update(nodeLicense).digest('hex') } },
  bundles: bundleInventories, ui: { inventoryPath: uiInventoryPath, inventory: uiInventory },
};
await writeFile(join(output, 'distribution-sbom.json'), JSON.stringify(sbom, null, 2) + '\n');
await writeFile(join(output, 'studio-runner.cmd'), '@echo off\r\nrem Launch the bundled runtime and built UI; no package installation occurs.\r\n"%~dp0node.exe" "%~dp0runner.mjs" --ui-dir "%~dp0ui" %*\r\n');
await writeFile(join(output, 'studio-bridge.cmd'), '@echo off\r\nrem Relay MCP calls to the independent Studio Runner daemon.\r\n"%~dp0node.exe" "%~dp0bridge.mjs" %*\r\n');
await writeFile(join(output, 'README.ko.md'), '# Studio Runner 배포 후보\n\n고정된 Node 런타임과 빌드된 UI가 포함되어 있습니다. studio-runner.cmd로 실행합니다.\n이 산출물은 내부 설치 검증용이며 아직 공식 서명·업데이트 검증을 통과한 배포본이 아닙니다. 사용자 다운로드 페이지에 게시하지 않습니다.\n프로젝트 ZIP에는 이 런타임이나 개발 의존성을 넣지 않습니다.\n\ndistribution-sbom.json과 notices 및 ui/notices에 실제 번들 입력의 구성 목록과 원본 라이선스·고지를 보존했습니다. noticeComplete는 원문 수집 상태이며 법률 판단이나 공식 출시 승인이 아닙니다. gaps가 남아 있으면 공식 출시 고지 검사를 통과할 수 없습니다. Node 원본 고지는 NODE-LICENSE.txt를 확인하세요.\n');
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
await writeFile(join(output, 'build-manifest.json'), JSON.stringify({ version: '0.1.0', node: process.version, platform, distribution: 'internal-candidate', signed: false, releaseApproved: false, noticeComplete, sbom: 'distribution-sbom.json', files: inventory }, null, 2) + '\n');
process.stdout.write(output + '\n');
