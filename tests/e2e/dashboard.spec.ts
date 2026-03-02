/**
 * E2E tests for the Sprint Runner web dashboard.
 *
 * Prerequisites: `make test-setup` to create test milestones/issues.
 * The dashboard is started automatically by playwright.config.ts webServer.
 */
import { test, expect } from "@playwright/test";

test.describe("Dashboard Sprint Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for WebSocket connection and initial data load
    await page.waitForSelector(".phase-badge", { timeout: 10_000 });
    // Wait for milestone discovery to complete (issues loaded)
    await page.waitForTimeout(3000);
  });

  test("shows sprint header with sprint number", async ({ page }) => {
    const header = page.locator("#sprint-label");
    await expect(header).toContainText("Sprint");
  });

  test("displays issues for active sprint", async ({ page }) => {
    // Should have at least some issues loaded
    const issueItems = page.locator("#issue-list li");
    await expect(issueItems.first()).toBeVisible({ timeout: 10_000 });
    const count = await issueItems.count();
    expect(count).toBeGreaterThan(0);
  });

  test("sprint navigation buttons are visible", async ({ page }) => {
    const prevBtn = page.locator("#btn-prev");
    const nextBtn = page.locator("#btn-next");
    await expect(prevBtn).toBeVisible();
    await expect(nextBtn).toBeVisible();
  });

  test("can navigate to Sprint 2 and see its issues", async ({ page }) => {
    // Click next to go to Sprint 2
    const nextBtn = page.locator("#btn-next");
    await expect(nextBtn).toBeEnabled({ timeout: 10_000 });
    await nextBtn.click();

    // Sprint header should show Sprint 2
    const header = page.locator("#sprint-label");
    await expect(header).toContainText("2", { timeout: 5_000 });

    // Sprint 2 should have test issues
    const issueItems = page.locator("#issue-list li");
    await expect(issueItems.first()).toBeVisible({ timeout: 10_000 });
    const count = await issueItems.count();
    expect(count).toBeGreaterThanOrEqual(3); // 3 test issues in Sprint 2
  });

  test("can navigate back to Sprint 1 and see its issues", async ({ page }) => {
    // Go to Sprint 2
    const nextBtn = page.locator("#btn-next");
    await expect(nextBtn).toBeEnabled({ timeout: 10_000 });
    await nextBtn.click();
    await expect(page.locator("#sprint-label")).toContainText("2", { timeout: 5_000 });

    // Go back to Sprint 1
    const prevBtn = page.locator("#btn-prev");
    await prevBtn.click();
    await expect(page.locator("#sprint-label")).toContainText("1", { timeout: 5_000 });

    // Sprint 1 should still have issues
    const issueItems = page.locator("#issue-list li");
    await expect(issueItems.first()).toBeVisible({ timeout: 10_000 });
    const count = await issueItems.count();
    expect(count).toBeGreaterThan(0);
  });

  test("issues persist after rapid sprint switching", async ({ page }) => {
    const nextBtn = page.locator("#btn-next");
    const prevBtn = page.locator("#btn-prev");

    await expect(nextBtn).toBeEnabled({ timeout: 10_000 });

    // Rapid switching: 1→2→1→2→1
    await nextBtn.click();
    await page.waitForTimeout(500);
    await prevBtn.click();
    await page.waitForTimeout(500);
    await nextBtn.click();
    await page.waitForTimeout(500);
    await prevBtn.click();
    await page.waitForTimeout(500);

    // Should be back on Sprint 1 with issues visible
    await expect(page.locator("#sprint-label")).toContainText("1");
    const issueItems = page.locator("#issue-list li");
    await expect(issueItems.first()).toBeVisible({ timeout: 5_000 });
    expect(await issueItems.count()).toBeGreaterThan(0);
  });

  test("phase badge shows a valid phase", async ({ page }) => {
    const badge = page.locator(".phase-badge");
    const text = await badge.textContent();
    expect(["init", "plan", "execute", "review", "retro", "complete", "failed", "paused"]).toContain(text);
  });

  test("activity log section exists", async ({ page }) => {
    const activitySection = page.locator("#activity-panel");
    await expect(activitySection).toBeVisible();
    // Activity list UL exists in DOM (may be empty when no sprint is running)
    const activityList = page.locator("#activity-list");
    await expect(activityList).toHaveCount(1);
  });

  test("GitHub links work on issue numbers", async ({ page }) => {
    // Wait for issues to load
    const issueItems = page.locator("#issue-list li");
    await expect(issueItems.first()).toBeVisible({ timeout: 10_000 });
    // Check that issue items have links
    const issueLink = page.locator("#issue-list a[href*='issues/']").first();
    if (await issueLink.count() > 0) {
      const href = await issueLink.getAttribute("href");
      expect(href).toContain("/issues/");
    }
  });
});

test.describe("Dashboard API Endpoints", () => {
  test("/api/sprints returns both sprints", async ({ request }) => {
    const res = await request.get("/api/sprints");
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    const numbers = data.map((s: { sprintNumber: number }) => s.sprintNumber);
    expect(numbers).toContain(1);
    expect(numbers).toContain(2);
  });

  test("/api/sprints/1/issues returns issues", async ({ request }) => {
    // Wait for issue cache to load
    await new Promise((r) => setTimeout(r, 3000));
    const res = await request.get("/api/sprints/1/issues");
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.length).toBeGreaterThan(0);
  });

  test("/api/sprints/2/issues returns Sprint 2 issues", async ({ request }) => {
    // Wait for issue cache to load
    await new Promise((r) => setTimeout(r, 3000));
    const res = await request.get("/api/sprints/2/issues");
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.length).toBeGreaterThanOrEqual(3);
  });

  test("/api/sprints/1/state returns valid state", async ({ request }) => {
    const res = await request.get("/api/sprints/1/state");
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.sprintNumber).toBe(1);
    expect(data.phase).toBeDefined();
  });

  test("/api/repo returns repo URL", async ({ request }) => {
    const res = await request.get("/api/repo");
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.url).toContain("github.com");
  });
});
