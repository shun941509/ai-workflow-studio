import { defineConfig } from '@playwright/test';

/** Reuse the coordinated web server; fixture transport is isolated to the explicit attachment-race case. */
export default defineConfig({ testDir: '.', testMatch: 'agentic-authoring.spec.ts', timeout: 120000, expect: { timeout: 20000 }, workers: 1, fullyParallel: false, reporter: 'list', outputDir: '../../test-results/agentic-authoring', use: { baseURL: process.env.STUDIO_WEB_TEST_URL ?? 'http://127.0.0.1:3101', browserName: 'chromium', channel: 'chrome', viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', trace: 'retain-on-failure', screenshot: 'only-on-failure' } });
