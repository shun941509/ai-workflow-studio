import { defineConfig } from '@playwright/test';
/** Uses an already-running local web server; no account, bucket or public release is provisioned. */
export default defineConfig({ testDir: '.', testMatch: 'publication-delivery.spec.ts', timeout: 60000, workers: 1, reporter: [['list']], outputDir: '../../test-results/publication-delivery', use: { baseURL: process.env.STUDIO_PUBLICATIONS_TEST_URL ?? 'http://127.0.0.1:3101' } });
