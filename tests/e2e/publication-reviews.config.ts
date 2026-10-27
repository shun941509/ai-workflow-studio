import { defineConfig } from '@playwright/test';
/** HTTP acceptance uses the existing isolated 3101 server, without provisioning external Auth or Storage. */
export default defineConfig({ testDir: '.', testMatch: 'publication-reviews.spec.ts', timeout: 60000, workers: 1, reporter: [['list']], outputDir: '../../test-results/publication-reviews', use: { baseURL: process.env.STUDIO_PUBLICATIONS_TEST_URL ?? 'http://127.0.0.1:3101', browserName: 'chromium', channel: 'chrome' } });
