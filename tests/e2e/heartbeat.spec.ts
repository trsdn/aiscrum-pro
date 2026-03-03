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
  test("status indicator is visible in header", async ({ page }) => {
    await waitForDashboard(page);
    const indicator = page.locator(".status-indicator");
    await expect(indicator).toBeVisible();
  });

  test("status indicator shows ok state when connected", async ({ page }) => {
    await waitForDashboard(page);
    await page.waitForTimeout(3000);
    const indicator = page.locator(".status-indicator");
    await expect(indicator).toHaveClass(/status-ok|status-warn/, { timeout: 35_000 });
  });

  test("status indicator has title attribute", async ({ page }) => {
    await waitForDashboard(page);
    await page.waitForTimeout(3000);
    const indicator = page.locator(".status-indicator");
    const title = await indicator.getAttribute("title");
    expect(title).toBeTruthy();
  });
});
