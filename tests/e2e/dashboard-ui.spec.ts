/**
 * Comprehensive E2E tests for all dashboard UI functionality.
 *
 * Covers: tab navigation, settings page, logs page, blocked/decisions tabs,
 * backlog, ideas, notifications toggle, header controls, and API endpoints.
 */
import { test, expect } from "@playwright/test";

// Helper: navigate to a tab by its exact icon+label (e.g. "🏃 Sprint")
const TAB_ICONS: Record<string, string> = {
  "Sprint": "🏃", "Sprint Backlog": "📦", "Backlog": "📋",
  "Blocked": "🚧", "Decisions": "⚖️", "Ideas": "💡",
  "Report": "📊", "Logs": "📜", "Settings": "⚙️",
};
async function navigateToTab(page: import("@playwright/test").Page, label: string) {
  await page.waitForSelector(".tab-nav", { timeout: 10_000 });
  const fullText = `${TAB_ICONS[label] ?? ""} ${label}`;
  const tab = page.getByRole("button", { name: fullText, exact: true });
  await tab.click();
  await page.waitForTimeout(500);
}

test.describe("Tab Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".tab-nav", { timeout: 10_000 });
  });

  const tabs = [
    { label: "Sprint", selector: ".sprint-main" },
    { label: "Sprint Backlog", selector: ".tab-list-container, .tab-empty, .tab-loading" },
    { label: "Backlog", selector: ".tab-list-container, .tab-empty, .tab-loading" },
    { label: "Blocked", selector: ".tab-list-container, .tab-empty, .tab-loading" },
    { label: "Decisions", selector: ".tab-list-container, .tab-empty, .tab-loading" },
    { label: "Ideas", selector: ".tab-list-container, .tab-empty, .tab-loading" },
    { label: "Report", selector: ".sprint-report" },
    { label: "Logs", selector: ".log-terminal" },
    { label: "Settings", selector: ".settings-page" },
  ];

  for (const { label, selector } of tabs) {
    test(`navigates to ${label} tab`, async ({ page }) => {
      await navigateToTab(page, label);
      const target = page.locator(selector);
      await expect(target.first()).toBeVisible({ timeout: 5_000 });
    });
  }

  test("active tab is visually highlighted", async ({ page }) => {
    const settingsBtn = page.locator("button.tab-btn", { hasText: "Settings" });
    await settingsBtn.click();
    await expect(settingsBtn).toHaveClass(/tab-active/);
  });
});

test.describe("Header Controls", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".phase-badge", { timeout: 10_000 });
    await page.waitForTimeout(3000);
  });

  test("notification toggle changes icon", async ({ page }) => {
    const notifBtn = page.locator("button", { hasText: /🔔|🔕/ });
    await expect(notifBtn).toBeVisible();
    const initialText = await notifBtn.textContent();
    await notifBtn.click();
    await page.waitForTimeout(300);
    const newText = await notifBtn.textContent();
    // Icon should have toggled
    expect(newText).not.toBe(initialText);
  });

  test("notification toggle persists after page reload", async ({ page }) => {
    const notifBtn = page.locator("button", { hasText: /🔔|🔕/ });
    // Get initial state
    const initialText = await notifBtn.textContent();
    // Toggle
    await notifBtn.click();
    await page.waitForTimeout(300);
    const toggledText = await notifBtn.textContent();
    expect(toggledText).not.toBe(initialText);
    // Reload and check persistence
    await page.reload();
    await page.waitForSelector(".phase-badge", { timeout: 10_000 });
    await page.waitForTimeout(3000);
    const afterReload = page.locator("button", { hasText: /🔔|🔕/ });
    await expect(afterReload).toHaveText(toggledText!);
  });

  test("execution mode dropdown is visible", async ({ page }) => {
    const modeSelect = page.locator("select").filter({ hasText: /Autonomous|Manual/ });
    await expect(modeSelect).toBeVisible();
  });

  test("done count is shown", async ({ page }) => {
    const issueCount = page.locator(".issue-count");
    await expect(issueCount).toBeVisible();
    const text = await issueCount.textContent();
    expect(text).toMatch(/\d+\/\d+ done/);
  });

  test("connection status indicator is visible", async ({ page }) => {
    const indicator = page.locator(".status-indicator");
    await expect(indicator).toBeVisible();
  });

  test("elapsed time is displayed", async ({ page }) => {
    const elapsed = page.locator(".elapsed");
    await expect(elapsed).toBeVisible();
  });
});

test.describe("Settings Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "Settings");
  });

  test("shows settings heading", async ({ page }) => {
    const heading = page.locator(".settings-page h1");
    await expect(heading).toContainText("Settings");
  });

  test("shows project config section", async ({ page }) => {
    const section = page.locator("text=Project");
    await expect(section.first()).toBeVisible();
  });

  test("shows sprint config section", async ({ page }) => {
    const section = page.locator("text=Sprint");
    await expect(section.first()).toBeVisible();
  });

  test("shows notifications section", async ({ page }) => {
    const section = page.locator("text=Notifications");
    await expect(section.first()).toBeVisible();
  });

  test("shows agent roles section", async ({ page }) => {
    const section = page.locator("text=Agent Roles");
    await expect(section.first()).toBeVisible();
  });

  test("shows quality gates section", async ({ page }) => {
    const section = page.locator("text=Quality Gates");
    await expect(section.first()).toBeVisible();
  });

  test("has save button", async ({ page }) => {
    const saveBtn = page.locator("button", { hasText: /Save/i });
    await expect(saveBtn.first()).toBeVisible();
  });

  test("agent role tabs are clickable", async ({ page }) => {
    // Wait for roles to load
    await page.waitForTimeout(2000);
    const roleTabs = page.locator(".role-tab");
    const count = await roleTabs.count();
    if (count > 1) {
      await roleTabs.nth(1).click();
      await expect(roleTabs.nth(1)).toHaveClass(/role-tab-active/);
    }
  });

  test("config values are editable", async ({ page }) => {
    // Find a text input and verify it's editable
    const inputs = page.locator(".settings-table input[type='text'], .settings-table input[type='number']");
    const count = await inputs.count();
    expect(count).toBeGreaterThan(0);
    const first = inputs.first();
    await expect(first).toBeEditable();
  });
});

test.describe("Logs Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "Logs");
  });

  test("shows log terminal", async ({ page }) => {
    const terminal = page.locator(".log-terminal");
    await expect(terminal).toBeVisible();
  });

  test("has Error Log and Live mode toggles", async ({ page }) => {
    const errorLogBtn = page.locator(".log-mode-btn", { hasText: "Error Log" });
    const liveBtn = page.locator(".log-mode-btn", { hasText: "Live" });
    await expect(errorLogBtn).toBeVisible();
    await expect(liveBtn).toBeVisible();
  });

  test("can switch between Error Log and Live modes", async ({ page }) => {
    const liveBtn = page.locator(".log-mode-btn", { hasText: "Live" });
    await liveBtn.click();
    await expect(liveBtn).toHaveClass(/active/);

    const errorLogBtn = page.locator(".log-mode-btn", { hasText: "Error Log" });
    await errorLogBtn.click();
    await expect(errorLogBtn).toHaveClass(/active/);
  });

  test("has filter buttons (All, Errors, Warnings)", async ({ page }) => {
    const allBtn = page.locator(".log-filter-btn", { hasText: /All/ });
    const errBtn = page.locator(".log-filter-btn", { hasText: /Errors/ });
    const warnBtn = page.locator(".log-filter-btn", { hasText: /Warnings/ });
    await expect(allBtn).toBeVisible();
    await expect(errBtn).toBeVisible();
    await expect(warnBtn).toBeVisible();
  });

  test("filter buttons are clickable", async ({ page }) => {
    const errBtn = page.locator(".log-filter-btn", { hasText: /Errors/ });
    await errBtn.click();
    await expect(errBtn).toHaveClass(/active/);
  });

  test("Live mode shows log content or empty state", async ({ page }) => {
    const liveBtn = page.locator(".log-mode-btn", { hasText: "Live" });
    await liveBtn.click();
    // Live mode shows either log lines or an empty state message
    const body = page.locator(".log-terminal-body");
    await expect(body).toBeVisible();
  });
});

test.describe("Blocked Tab", () => {
  test("shows blocked issues or empty state", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "Blocked");
    const content = page.locator(".tab-list-container, .tab-empty, .tab-loading");
    await expect(content.first()).toBeVisible({ timeout: 5_000 });
  });
});

test.describe("Decisions Tab", () => {
  test("shows decisions or empty state", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "Decisions");
    const content = page.locator(".tab-list-container, .tab-empty, .tab-loading");
    await expect(content.first()).toBeVisible({ timeout: 5_000 });
  });
});

test.describe("Ideas Tab", () => {
  test("shows ideas or empty state", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "Ideas");
    const content = page.locator(".tab-list-container, .tab-empty, .tab-loading");
    await expect(content.first()).toBeVisible({ timeout: 5_000 });
  });
});

test.describe("Backlog Tab", () => {
  test("shows backlog or empty state", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "Backlog");
    const content = page.locator(".tab-list-container, .tab-empty, .tab-loading");
    await expect(content.first()).toBeVisible({ timeout: 5_000 });
  });
});

test.describe("Sprint Report Tab", () => {
  test("shows sprint report content", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "Report");
    const report = page.locator(".sprint-report");
    await expect(report).toBeVisible({ timeout: 5_000 });
  });

  test("report has heading", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "Report");
    const heading = page.locator(".sprint-report h1");
    await expect(heading).toContainText("Sprint Report");
  });
});

test.describe("API Endpoints", () => {
  test("/api/config GET returns valid config", async ({ request }) => {
    const res = await request.get("/api/config");
    expect(res.status()).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("project");
    expect(data).toHaveProperty("sprint");
    expect(data).toHaveProperty("escalation");
  });

  test("/api/roles GET returns agent roles", async ({ request }) => {
    const res = await request.get("/api/roles");
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    if (data.length > 0) {
      expect(data[0]).toHaveProperty("name");
      expect(data[0]).toHaveProperty("instructions");
    }
  });

  test("/api/quality-gates GET returns config", async ({ request }) => {
    const res = await request.get("/api/quality-gates");
    expect(res.status()).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("checks");
  });

  test("/api/blocked returns array", async ({ request }) => {
    const res = await request.get("/api/blocked");
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("/api/decisions returns array", async ({ request }) => {
    const res = await request.get("/api/decisions");
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("/api/logs returns log files or empty", async ({ request }) => {
    const res = await request.get("/api/logs");
    expect(res.status()).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("files");
  });

  test("/api/repo returns repo info", async ({ request }) => {
    const res = await request.get("/api/repo");
    expect(res.status()).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("url");
  });

  test("/api/sprints returns array", async ({ request }) => {
    const res = await request.get("/api/sprints");
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("unknown API endpoint returns 404", async ({ request }) => {
    const res = await request.get("/api/nonexistent");
    expect(res.status()).toBe(404);
  });
});
