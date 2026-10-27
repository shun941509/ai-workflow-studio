import { defineConfig } from '@playwright/test';

/** Isolated Chrome coverage uses the dedicated 3101 instance and never touches the production preview on 3100. */
export default defineConfig({
  testDir: '.', testMatch: 'publications.spec.ts', timeout: 60000, expect: { timeout: 15000 }, workers: 1,
  fullyParallel: false, reporter: [['list']], outputDir: '../../test-results/publications',
  use: { baseURL: process.env.STUDIO_PUBLICATIONS_TEST_URL ?? 'http://127.0.0.1:3101', browserName: 'chromium', channel: 'chrome', viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
