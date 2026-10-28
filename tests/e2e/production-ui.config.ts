import { defineConfig } from '@playwright/test';

/** One serial browser pass checks the built authoring, library and moderation surfaces together.
 * Connected-service response fixtures remain test-only; live Supabase/host release evidence is separate. */
export default defineConfig({
  testDir: '.',
  testMatch: ['studio-web.spec.ts', 'operational-editor.spec.ts', 'binding-picker.spec.ts', 'subflows.spec.ts', 'rag-authoring.spec.ts', 'rerank-authoring.spec.ts', 'agentic-authoring.spec.ts', 'completion-authoring.spec.ts', 'work-definition-authoring.spec.ts', 'canvas-navigation.spec.ts', 'reviews-ui.spec.ts', 'publications.spec.ts', 'publication-download-ui.spec.ts', 'publication-copy.spec.ts', 'publication-reviews.spec.ts'],
  timeout: 90000, expect: { timeout: 20000 }, workers: 1, fullyParallel: false,
  reporter: [['list']], outputDir: '../../test-results/production-ui',
  use: {
    baseURL: process.env.STUDIO_PRODUCTION_TEST_URL ?? 'http://127.0.0.1:3100',
    browserName: 'chromium', channel: 'chrome', viewport: { width: 1440, height: 1000 },
    locale: 'ko-KR', trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
});
