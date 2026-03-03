/**
 * E2E tests for round 3 bug fixes:
 * - External link security (noreferrer)
 * - Sprint number validation
 * - IssueCard rendering
 * - Sprint navigation robustness
 * - Backlog/Sprint Backlog actions
 */
import { test, expect } from "@playwright/test";

const BASE = "http://localhost:9200";

async function navigateToTab(page: import("@playwright/test").Page, icon: string, label: string) {
  await page.waitForSelector(".tab-nav", { timeout: 10_000 });
  await page.getByRole("button", { name: `${icon} ${label}`, exact: true }).click();
  await page.waitForTimeout(500);
}

// ─── External Link Security ────────────────────────────────────

test.describe("External Link Security", () => {
  test("issue links have noreferrer attribute", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".phase-badge", { timeout: 10_000 });
    await page.waitForTimeout(3000);
    // Check any issue links in the sprint tab
    const links = page.locator("a[target='_blank']");
    const count = await links.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      const rel = await links.nth(i).getAttribute("rel");
      expect(rel).toContain("noreferrer");
    }
  });

  test("header sprint link has noreferrer", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".phase-badge", { timeout: 10_000 });
    const sprintLink = page.locator("#sprint-label a[target='_blank']");
    if (await sprintLink.count() > 0) {
      const rel = await sprintLink.getAttribute("rel");
      expect(rel).toContain("noreferrer");
    }
  });

  test("issue card links in backlog have noreferrer", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "📋", "Backlog");
    await page.waitForTimeout(2000);
    const links = page.locator(".tab-list a[target='_blank']");
    const count = await links.count();
    for (let i = 0; i < Math.min(count, 3); i++) {
      const rel = await links.nth(i).getAttribute("rel");
      expect(rel).toContain("noreferrer");
    }
  });
});

// ─── Sprint Number Validation ──────────────────────────────────

test.describe("Sprint Number Validation", () => {
  test("invalid sprint number returns 400", async ({ request }) => {
    const res = await request.get(`${BASE}/api/sprint-backlog?sprint=abc`);
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  test("negative sprint number returns 400", async ({ request }) => {
    const res = await request.get(`${BASE}/api/sprint-backlog?sprint=-1`);
    expect(res.status()).toBe(400);
  });

  test("zero sprint number returns 400", async ({ request }) => {
    const res = await request.get(`${BASE}/api/sprint-backlog?sprint=0`);
    expect(res.status()).toBe(400);
  });

  test("valid sprint number returns 200", async ({ request }) => {
    const res = await request.get(`${BASE}/api/sprint-backlog?sprint=1`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty("items");
  });

  test("no sprint parameter returns 200 with default", async ({ request }) => {
    const res = await request.get(`${BASE}/api/sprint-backlog`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty("items");
  });
});

// ─── IssueCard Rendering ───────────────────────────────────────

test.describe("IssueCard Rendering", () => {
  test("backlog items render with number and title", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "📋", "Backlog");
    await page.waitForTimeout(2000);
    const items = page.locator(".tab-list-item");
    if (await items.count() > 0) {
      // First item should have a visible number
      const firstNumber = items.first().locator(".item-number");
      await expect(firstNumber).toBeVisible();
      const text = await firstNumber.textContent();
      expect(text).toMatch(/^#\d+$/);
      // Should have a title
      const firstTitle = items.first().locator(".item-title");
      await expect(firstTitle).toBeVisible();
      const title = await firstTitle.textContent();
      expect(title!.length).toBeGreaterThan(0);
    }
  });

  test("issue card expand/collapse works", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "📋", "Backlog");
    await page.waitForTimeout(2000);
    const expandBtn = page.locator(".item-expand-toggle").first();
    if (await expandBtn.count() > 0) {
      // Initially collapsed
      const detail = page.locator(".item-detail").first();
      await expect(detail).not.toBeVisible();
      // Click to expand
      await expandBtn.click();
      await page.waitForTimeout(300);
      await expect(detail).toBeVisible();
      // Click to collapse
      await expandBtn.click();
      await page.waitForTimeout(300);
      await expect(detail).not.toBeVisible();
    }
  });

  test("expanded issue card shows body or 'No description'", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "📋", "Backlog");
    await page.waitForTimeout(2000);
    const expandBtn = page.locator(".item-expand-toggle").first();
    if (await expandBtn.count() > 0) {
      await expandBtn.click();
      await page.waitForTimeout(300);
      // Should show either body content or empty message
      const bodyOrEmpty = page.locator(".item-body-full, .item-body-empty").first();
      await expect(bodyOrEmpty).toBeVisible();
    }
  });

  test("issue labels render as badges", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "📋", "Backlog");
    await page.waitForTimeout(2000);
    const labels = page.locator(".label-badge");
    if (await labels.count() > 0) {
      await expect(labels.first()).toBeVisible();
      const text = await labels.first().textContent();
      expect(text!.length).toBeGreaterThan(0);
    }
  });
});

// ─── Sprint Navigation ─────────────────────────────────────────

test.describe("Sprint Navigation", () => {
  test("sprint navigation buttons exist in header", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".phase-badge", { timeout: 10_000 });
    const prevBtn = page.locator("#btn-prev");
    const nextBtn = page.locator("#btn-next");
    await expect(prevBtn).toBeVisible();
    await expect(nextBtn).toBeVisible();
  });

  test("sprint badge shows current sprint number", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".phase-badge", { timeout: 10_000 });
    const badge = page.locator("#sprint-label");
    await expect(badge).toBeVisible();
    const text = await badge.textContent();
    expect(text).toMatch(/Sprint \d/);
  });

  test("sprint tab issue list shows status icons", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".phase-badge", { timeout: 10_000 });
    await page.waitForTimeout(3000);
    const issueItems = page.locator(".issue-item");
    if (await issueItems.count() > 0) {
      const icon = issueItems.first().locator(".issue-icon");
      await expect(icon).toBeVisible();
      const text = await icon.textContent();
      // Should be one of the status icons
      expect(["○", "◐", "✓", "✗", "⊘", "·"]).toContain(text?.trim());
    }
  });
});

// ─── Sprint Backlog Tab ─────────────────────────────────────────

test.describe("Sprint Backlog Tab", () => {
  test("shows sprint number in heading", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "📦", "Sprint Backlog");
    await page.waitForTimeout(2000);
    const heading = page.locator("h2");
    if (await heading.count() > 0) {
      const text = await heading.first().textContent();
      // Either shows "Sprint N Backlog" or empty state
      if (text?.includes("Sprint")) {
        expect(text).toMatch(/Sprint \d+ Backlog/);
      }
    }
  });

  test("has refresh button that reloads data", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "📦", "Sprint Backlog");
    await page.waitForTimeout(2000);
    const refreshBtn = page.locator("button", { hasText: "↻" });
    if (await refreshBtn.count() > 0) {
      await refreshBtn.first().click();
      // Should show loading briefly
      await page.waitForTimeout(500);
      // Should return to content or empty state
      const content = page.locator(".tab-list-container, .tab-empty");
      await expect(content.first()).toBeVisible({ timeout: 5_000 });
    }
  });

  test("remove button exists on sprint backlog items", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "📦", "Sprint Backlog");
    await page.waitForTimeout(2000);
    const removeBtn = page.locator(".btn-danger", { hasText: "Remove" });
    if (await removeBtn.count() > 0) {
      await expect(removeBtn.first()).toBeVisible();
    }
  });
});

// ─── API Edge Cases ─────────────────────────────────────────────

test.describe("API Edge Cases", () => {
  test("sprints state endpoint handles non-existent sprint", async ({ request }) => {
    const res = await request.get(`${BASE}/api/sprints/9999/state`);
    // Should return 200 with null/empty data or 404
    expect([200, 404]).toContain(res.status());
  });

  test("PUT /api/config with malformed JSON returns 400", async ({ request }) => {
    const res = await request.put(`${BASE}/api/config`, {
      data: "not json",
      headers: { "Content-Type": "text/plain" },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/roles for non-existent role returns 404", async ({ request }) => {
    const res = await request.put(`${BASE}/api/roles`, {
      data: { name: "nonexistent-role-xyz", instructions: "test" },
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status()).toBe(404);
  });
});
