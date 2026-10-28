import { defineConfig } from '@playwright/test';

/** Uses the shared development server and a separate Chrome profile; does not start or stop another agent's server. */
export default defineConfig({ testDir: '.', testMatch: ['rag-authoring.spec.ts'], timeout: 120000, expect: { timeout: 20000 }, workers: 1, fullyParallel: false, reporter: [['list']], outputDir: '../../test-results/rag-authoring', use: { baseURL: process.env.STUDIO_WEB_TEST_URL ?? 'http://127.0.0.1:3101', browserName: 'chromium', channel: 'chrome', viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', trace: 'retain-on-failure', screenshot: 'only-on-failure' } });
