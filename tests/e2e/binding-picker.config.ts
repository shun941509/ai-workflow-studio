import { defineConfig } from '@playwright/test';

/** Uses the shared local dev server and an isolated Chrome profile; it neither starts nor stops another agent's server. */
export default defineConfig({
  testDir: '.', testMatch: ['binding-picker.spec.ts'], timeout: 90000,
  expect: { timeout: 20000 }, workers: 1, fullyParallel: false, reporter: [['list']],
  outputDir: '../../test-results/binding-picker',
  use: { baseURL: process.env.STUDIO_WEB_TEST_URL ?? 'http://127.0.0.1:3101', browserName: 'chromium', channel: 'chrome', viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
