import { defineConfig } from 'vitest/config';

/** Internal tests may replace real network boundaries; those replacements never enter product exports. */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**', 'tests/hosts/**'],
    testTimeout: 15000,
    maxWorkers: 3,
  },
});
