import { defineConfig } from "@playwright/test";

/** A fresh Chrome profile exercises the local app without touching the user's existing browser session. */
export default defineConfig({
  testDir: ".",
  testMatch: ["studio-web.spec.ts", "operational-editor.spec.ts"],
  timeout: 60000,
  expect: { timeout: 15000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: "../../test-results/studio-web",
  use: {
    baseURL: process.env.STUDIO_WEB_TEST_URL ?? "http://127.0.0.1:3100",
    browserName: "chromium",
    channel: "chrome",
    viewport: { width: 1440, height: 1000 },
    locale: "ko-KR",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  }
});
