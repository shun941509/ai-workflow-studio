import { defineConfig } from '@playwright/test';

/** A coordinated development/production server is reused; no cloud account or provider is contacted by these cases. */
export default defineConfig({ testDir: '.', testMatch: 'completion-authoring.spec.ts', timeout: 120000, expect: { timeout: 20000 }, workers: 1, fullyParallel: false, reporter: 'list', outputDir: '../../test-results/completion-authoring', use: { baseURL: process.env.STUDIO_WEB_TEST_URL ?? 'http://127.0.0.1:3101', browserName: 'chromium', channel: 'chrome', viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', trace: 'retain-on-failure', screenshot: 'only-on-failure' } });
