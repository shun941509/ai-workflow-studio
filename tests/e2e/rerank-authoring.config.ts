import { defineConfig } from '@playwright/test';

/** Serial actual Chrome verification against the shared local server; no external model requests. */
export default defineConfig({ testDir: '.', testMatch: ['rerank-authoring.spec.ts'], timeout: 90000, expect: { timeout: 15000 }, workers: 1, fullyParallel: false, reporter: [['list']], outputDir: '../../test-results/rerank-authoring', use: { baseURL: process.env.STUDIO_WEB_TEST_URL ?? 'http://127.0.0.1:3101', browserName: 'chromium', channel: 'chrome', viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', trace: 'retain-on-failure', screenshot: 'only-on-failure' } });
