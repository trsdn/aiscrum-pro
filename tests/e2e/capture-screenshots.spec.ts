/**
 * Playwright script to capture dashboard screenshots for README/docs.
 *
 * Run: npx playwright test tests/e2e/capture-screenshots.spec.ts
 *
 * Prerequisites: make test-setup (populates test repo with data)
 * The webServer config in playwright.config.ts auto-starts the dashboard.
 */

import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SCREENSHOT_DIR = "docs/screenshots";

const TABS: { id: string; label: string; icon: string; name: string }[] = [
  { id: "sprint", label: "Sprint", icon: "🏃", name: "sprint-board" },
  { id: "sprint-backlog", label: "Sprint Backlog", icon: "📦", name: "sprint-backlog" },
  { id: "backlog", label: "Backlog", icon: "📋", name: "backlog" },
  { id: "blocked", label: "Blocked", icon: "🚧", name: "blocked" },
  { id: "decisions", label: "Decisions", icon: "⚖️", name: "decisions" },
  { id: "ideas", label: "Ideas", icon: "💡", name: "ideas" },
  { id: "report", label: "Report", icon: "📊", name: "report" },
  { id: "logs", label: "Logs", icon: "📜", name: "logs" },
  { id: "settings", label: "Settings", icon: "⚙️", name: "settings" },
];

test.describe("Dashboard Screenshots", () => {
  test.beforeAll(() => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.waitForSelector("header", { timeout: 15_000 });
    await page.waitForTimeout(2000);
  });

  for (const tab of TABS) {
    test(`capture ${tab.label}`, async ({ page }) => {
      if (tab.id !== "sprint") {
        const tabButton = page.getByRole("button", {
          name: `${tab.icon} ${tab.label}`,
          exact: true,
        });
        await tabButton.click();
        await page.waitForTimeout(1000);
      }

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/${tab.name}.png`,
        fullPage: false,
      });
    });
  }
});
