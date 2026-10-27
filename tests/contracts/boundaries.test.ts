import { describe, expect, it } from 'vitest';
import { findBoundaryViolations } from '../../tooling/boundaries/analyze.js';

/** Adversarial dependency graphs exercise escapes that a direct-import-only lint misses. */
describe('transitive package boundaries', () => {
  it('rejects client -> shared barrel -> native filesystem', () => {
    const result = findBoundaryViolations([{ path: 'apps/web/client.ts', text: "'use client'; import { read } from './shared.js';" }, { path: 'apps/web/shared.ts', text: "export { readFile as read } from 'fs/promises';" }], {});
    expect(result).toHaveLength(1); expect(result[0]).toContain('apps/web/client.ts -> apps/web/shared.ts');
  });
  it('rejects dynamic literal server imports through workspace exports', () => {
    const result = findBoundaryViolations([{ path: 'apps/web/client.ts', text: "'use client'; import('@studio/ui');" }, { path: 'packages/ui/src/index.ts', text: "import('node:child_process');" }], { '@studio/ui': 'packages/ui/src/index.ts' });
    expect(result[0]).toContain('node:child_process');
  });
  it('rejects unresolved dynamic imports in a pure package', () => {
    expect(findBoundaryViolations([{ path: 'packages/spec/src/index.ts', text: 'export const load = (name: string) => import(name);' }], {})).toEqual([expect.stringContaining('unresolved dynamic')]);
  });
  it('allows type-only Node references but still rejects cross-app internals', () => {
    expect(findBoundaryViolations([{ path: 'packages/spec/src/index.ts', text: "import type { Stats } from 'node:fs'; export type { Stats };" }], {})).toEqual([]);
    expect(findBoundaryViolations([{ path: 'apps/web/main.ts', text: "import type { Data } from '../runner/types.js';" }, { path: 'apps/runner/types.ts', text: 'export interface Data {}' }], {})).toEqual([expect.stringContaining('another app')]);
  });
  it('terminates on cyclic safe barrels and ignores comment text', () => {
    expect(findBoundaryViolations([{ path: 'apps/web/a.ts', text: "'use client'; export * from './b.js'; // import 'node:fs'" }, { path: 'apps/web/b.ts', text: "export * from './a.js';" }], {})).toEqual([]);
  });
  it('rejects server-only side effects and missing local modules', () => {
    expect(findBoundaryViolations([{ path: 'apps/web/client.ts', text: "'use client'; import './server-helper.js';" }, { path: 'apps/web/server-helper.ts', text: "import 'server-only';" }], {})).toEqual([expect.stringContaining('server module'), expect.stringContaining('server-only')]);
    expect(findBoundaryViolations([{ path: 'apps/web/client.ts', text: "'use client'; import './missing.js';" }], {})).toEqual([expect.stringContaining('unresolved local')]);
  });
});
