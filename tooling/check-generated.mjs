import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** A clean regeneration must not change checked-in contract types, even before the first Git commit exists. */
async function snapshot() {
  const result = new Map();
  for (const dir of ['packages/spec/src/generated', 'packages/package-kit/src/generated']) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name); result.set(path, createHash('sha256').update(await readFile(path)).digest('hex'));
    }
  }
  return JSON.stringify([...result]);
}
const before = await snapshot();
for (const script of ['tooling/generate-spec.ts', 'tooling/generate-package-types.ts']) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (before !== await snapshot()) throw new Error('생성 타입이 스키마와 다릅니다. 생성물을 검토하고 포함하세요.');
console.log('Generated contracts are current.');
