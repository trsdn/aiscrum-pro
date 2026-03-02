import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: "http://localhost:9200",
    headless: true,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  // Dashboard is started by the test setup, not by Playwright
  webServer: {
    command: "npx tsx src/index.ts web --config .aiscrum/config.test.yaml --no-open --port 9200",
    port: 9200,
    timeout: 15_000,
    reuseExistingServer: true,
  },
});
