/**
 * E2E tests for the heartbeat supervisor indicator in the dashboard header.
 */
import { test, expect, type Page } from "@playwright/test";

async function waitForDashboard(page: Page) {
  await page.goto("/");
  await page.waitForSelector(".phase-badge", { timeout: 10_000 });
  await page.waitForTimeout(1000);
}

test.describe("Heartbeat Indicator", () => {
  test("heartbeat dot is visible in header", async ({ page }) => {
    await waitForDashboard(page);
    const dots = page.locator(".status-dot");
    // Should have at least 2 dots: connection + heartbeat
    await expect(dots.first()).toBeVisible();
    const count = await dots.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("heartbeat dot has correct class", async ({ page }) => {
    await waitForDashboard(page);
    // Wait for heartbeat tick to arrive (up to 35s for 30s interval)
    await page.waitForTimeout(3000);
    const heartbeatDot = page.locator(".status-heartbeat-ok, .status-heartbeat-warn, .status-heartbeat-stale");
    await expect(heartbeatDot.first()).toBeVisible({ timeout: 35_000 });
  });

  test("heartbeat dot has title attribute", async ({ page }) => {
    await waitForDashboard(page);
    await page.waitForTimeout(3000);
    const heartbeatDot = page.locator(".status-heartbeat-ok, .status-heartbeat-warn, .status-heartbeat-stale");
    const title = await heartbeatDot.first().getAttribute("title");
    expect(title).toBeTruthy();
  });
});
