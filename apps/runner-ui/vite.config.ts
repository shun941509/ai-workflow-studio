import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNoticeInventory, type NoticeInput } from '../../tooling/distribution/notice-inventory.js';

const require = createRequire(import.meta.url);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Generate notice assets from retained production modules, not the package lock or every installed dependency. */
function productionNotices(): Plugin {
  const snapshots = new Map<string, Uint8Array>(); let appRoot = '';
  return { name: 'studio-production-notices', apply: 'build', enforce: 'pre',
    configResolved(config) { appRoot = config.root; },
    transform(code, id) { snapshots.set(id, new TextEncoder().encode(code)); return null; },
    async generateBundle(_options, bundle) {
      const retained = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') { for (const [id, module] of Object.entries(output.modules)) if (module.renderedLength > 0) retained.add(id); }
        else if (output.type === 'asset') { for (const file of output.originalFileNames) retained.add(isAbsolute(file) ? file : resolve(appRoot, file)); }
      }
      // Consult the actual module graph to preserve CSS consumed by a retained module and avoid unrelated loaded modules.
      const moduleIds = [...this.getModuleIds()]; for (const id of moduleIds) if (/\.css(?:\?|$)/.test(id) && this.getModuleInfo(id)?.importers.some((parent) => retained.has(parent))) retained.add(id);
      const inputs: NoticeInput[] = [];
      for (const id of retained) {
        const code = snapshots.get(id) ?? (this.getModuleInfo(id)?.code ? new TextEncoder().encode(this.getModuleInfo(id)!.code!) : undefined);
        const generatedLabel = `production-helper-${createHash('sha256').update(id).digest('hex').slice(0, 16)}.js`;
        if (id.includes('\0') || id.startsWith('vite/')) {
          // Vite's production preload helper is emitted code, so its own package notice belongs in the distribution.
          if (id.includes('vite/') || id.includes('vite:')) inputs.push({ id, contents: code, generatedOwner: require.resolve('vite/package.json'), generatedLabel });
          else if (id.includes('rolldown')) inputs.push({ id, contents: code, generatedOwner: createRequire(require.resolve('vite')).resolve('rolldown/package.json'), generatedLabel });
          else inputs.push({ id, contents: code });
        } else inputs.push({ id, contents: code });
      }
      const result = await collectNoticeInventory({ workspaceRoot, scope: 'runner-ui', inputs });
      for (const [fileName, source] of result.assets) this.emitFile({ type: 'asset', fileName, source });
      if (!result.inventory.noticeComplete) this.warn(`라이선스 고지 보완 필요: ${result.inventory.gaps.length}개. 이 빌드는 공식 배포 승인이 아닙니다.`);
    },
  };
}

/** This build is served by the authenticated Runner origin; no development server is exported. */
export default defineConfig({ plugins: [productionNotices(), react()], build: { outDir: 'dist', sourcemap: false }, base: '/' });
