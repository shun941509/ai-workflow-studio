import { defineConfig } from 'vitest/config';

/** Explicit opt-in only: a failing future contract must not enter the stable default test gate. */
export default defineConfig({ test: { include: ['tests/integration/runner-child-waits.pending.ts', 'tests/contracts/scope-waits.pending.ts', 'tests/contracts/child-execution.pending.ts'], maxWorkers: 1, testTimeout: 15000 } });
