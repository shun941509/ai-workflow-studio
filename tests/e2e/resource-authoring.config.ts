import { defineConfig } from '@playwright/test';
/** This isolated Chrome suite starts a test-only transport; no configured cloud account or live model is implied. */
export default defineConfig({ testDir: '.', testMatch: 'resource-authoring.spec.ts', workers: 1, timeout: 60000, use: { browserName: 'chromium', channel: 'chrome', headless: true, viewport: { width: 1440, height: 1000 } }, outputDir: '../../test-results/resource-authoring', reporter: 'list' });
