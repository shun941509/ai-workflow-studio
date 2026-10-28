import { defineConfig } from '@playwright/test';

/** Uses the shared dev server without starting, stopping or mutating another agent's server. */
export default defineConfig({ testDir: '.', testMatch: ['subflows.spec.ts'], timeout: 90000, expect: { timeout: 15000 }, workers: 1, fullyParallel: false, reporter: [['list']], outputDir: '../../test-results/subflows', use: { baseURL: process.env.STUDIO_WEB_TEST_URL ?? 'http://127.0.0.1:3101', browserName: 'chromium', channel: 'chrome', viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', trace: 'retain-on-failure', screenshot: 'only-on-failure' } });
