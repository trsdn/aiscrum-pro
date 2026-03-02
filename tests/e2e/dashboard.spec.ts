/**
 * E2E tests for the Sprint Runner web dashboard.
 *
 * The dashboard is started automatically by playwright.config.ts webServer.
 * Tests are designed to work with any repo state (0 or more sprints/issues).
 */
import { test, expect } from "@playwright/test";

test.describe("Dashboard Sprint Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for WebSocket connection and initial data load
    await page.waitForSelector(".phase-badge", { timeout: 10_000 });
    // Wait for sprint list + auto-navigation to complete
    await page.waitForTimeout(5000);
  });

  test("shows sprint header with sprint number", async ({ page }) => {
    const header = page.locator("#sprint-label");
    await expect(header).toContainText("Sprint");
  });

  test("sprint view renders with panels", async ({ page }) => {
    // Sprint-main container should be visible
    const sprintMain = page.locator(".sprint-main");
    await expect(sprintMain).toBeVisible();
    // Panel titles (Issues, Activity, ACP Sessions) should render
    const panelTitles = page.locator(".panel-title");
    await expect(panelTitles.first()).toBeVisible({ timeout: 5_000 });
    const count = await panelTitles.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("issue list exists in DOM", async ({ page }) => {
    // Issue list or empty state should be present
    const issueContainer = page.locator("#issue-list, .empty-state");
    await expect(issueContainer.first()).toBeVisible({ timeout: 10_000 });
  });

  test("sprint navigation buttons are visible", async ({ page }) => {
    const prevBtn = page.locator("#btn-prev");
    const nextBtn = page.locator("#btn-next");
    await expect(prevBtn).toBeVisible();
    await expect(nextBtn).toBeVisible();
  });

  test("can navigate between sprints", async ({ page }) => {
    const prevBtn = page.locator("#btn-prev");
    const header = page.locator("#sprint-label");

    const initialText = await header.textContent();
    const initialMatch = initialText?.match(/Sprint\s+(\d+)/);
    const initialNum = initialMatch ? parseInt(initialMatch[1], 10) : 0;

    if (initialNum > 1) {
      await prevBtn.click();
      await expect(header).toContainText(`Sprint ${initialNum - 1}`, { timeout: 5_000 });
    }
  });

  test("phase badge shows a valid phase", async ({ page }) => {
    const badge = page.locator(".phase-badge");
    const text = await badge.textContent();
    expect(["INIT", "PLAN", "EXECUTE", "REVIEW", "RETRO", "COMPLETE", "FAILED", "PAUSED"]).toContain(text);
  });

  test("chat panel exists in sprint view", async ({ page }) => {
    const sidePanel = page.locator(".sprint-chat-pane .side-panel");
    await expect(sidePanel).toHaveCount(1, { timeout: 5000 });
  });
});

test.describe("Dashboard API Endpoints", () => {
  test("/api/sprints returns sprint list", async ({ request }) => {
    const res = await request.get("/api/sprints");
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].sprintNumber).toBeDefined();
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

  test("/api/sprints/N/issues returns array", async ({ request }) => {
    const res = await request.get("/api/sprints/1/issues");
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("/api/config returns config object", async ({ request }) => {
    const res = await request.get("/api/config");
    expect(res.status()).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("project");
    expect(data).toHaveProperty("sprint");
    expect(data).toHaveProperty("quality_gates");
  });
});

test.describe("Dashboard Settings Page", () => {
  test("settings tab navigates to settings page", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".tab-nav", { timeout: 10_000 });
    const settingsTab = page.locator("button.tab-btn", { hasText: "Settings" });
    await settingsTab.click();
    const heading = page.locator(".settings-page h1");
    await expect(heading).toContainText("Settings", { timeout: 5000 });
  });
});
