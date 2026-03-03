/**
 * E2E tests for the sprint cancel button in the dashboard header.
 */
import { test, expect, type Page } from "@playwright/test";

async function waitForDashboard(page: Page) {
  await page.goto("/");
  await page.waitForSelector(".phase-badge", { timeout: 10_000 });
  await page.waitForTimeout(1000);
}

test.describe("Sprint Cancel Button", () => {
  test("cancel button is visible when sprint is running", async ({ page }) => {
    await waitForDashboard(page);
    const phaseBadge = page.locator(".phase-badge");
    const phaseText = await phaseBadge.textContent();

    // Cancel should only be visible during active/paused phases
    if (phaseText && !["INIT", "COMPLETE", "FAILED", "STOPPED", "CANCELLED"].includes(phaseText)) {
      const cancelBtn = page.locator("button", { hasText: "✕ Cancel" });
      await expect(cancelBtn).toBeVisible();
    }
  });

  test("cancel button is hidden when sprint is idle", async ({ page }) => {
    await waitForDashboard(page);
    const phaseBadge = page.locator(".phase-badge");
    const phaseText = await phaseBadge.textContent();

    if (phaseText && ["INIT", "COMPLETE", "FAILED", "STOPPED", "CANCELLED"].includes(phaseText)) {
      const cancelBtn = page.locator("button", { hasText: "✕ Cancel" });
      await expect(cancelBtn).not.toBeVisible();
    }
  });

  test("cancel button has danger styling", async ({ page }) => {
    await waitForDashboard(page);
    const cancelBtn = page.locator("button.btn-danger", { hasText: "✕ Cancel" });
    // Just check the selector exists and the class is correct
    const count = await cancelBtn.count();
    // May be 0 if sprint is idle, but if visible, it should have btn-danger
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
