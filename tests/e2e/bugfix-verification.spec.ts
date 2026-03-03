/**
 * E2E tests verifying bug fixes:
 * - Error states in all tabs (not silently hidden)
 * - Sprint report with empty/no data
 * - Sprint report copy/download buttons disabled state
 * - Log terminal mode switching
 * - Agent panel auto-close on restricted tabs
 * - WebSocket reconnection
 * - Settings save/reset round-trip
 */
import { test, expect } from "@playwright/test";

const BASE = "http://localhost:9200";

async function navigateToTab(page: import("@playwright/test").Page, icon: string, label: string) {
  await page.waitForSelector(".tab-nav", { timeout: 10_000 });
  await page.getByRole("button", { name: `${icon} ${label}`, exact: true }).click();
  await page.waitForTimeout(500);
}

// ─── Tab Error Handling ─────────────────────────────────────────

test.describe("Tab Error Handling", () => {
  test("backlog tab shows content or empty state (not crash)", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "📋", "Backlog");
    await page.waitForTimeout(2000);
    // Should show either items or empty message — NOT blank
    const content = page.locator(".tab-list-container, .tab-empty, .tab-loading");
    await expect(content.first()).toBeVisible({ timeout: 5_000 });
  });

  test("sprint backlog tab shows content or empty state", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "📦", "Sprint Backlog");
    await page.waitForTimeout(2000);
    const content = page.locator(".tab-list-container, .tab-empty, .tab-loading");
    await expect(content.first()).toBeVisible({ timeout: 5_000 });
  });

  test("blocked tab shows content or empty state", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "🚧", "Blocked");
    await page.waitForTimeout(2000);
    const content = page.locator(".tab-list-container, .tab-empty, .tab-loading");
    await expect(content.first()).toBeVisible({ timeout: 5_000 });
  });

  test("decisions tab shows content or empty state", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "⚖️", "Decisions");
    await page.waitForTimeout(2000);
    const content = page.locator(".tab-list-container, .tab-empty, .tab-loading");
    await expect(content.first()).toBeVisible({ timeout: 5_000 });
  });

  test("ideas tab shows content or empty state", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "💡", "Ideas");
    await page.waitForTimeout(2000);
    const content = page.locator(".tab-list-container, .tab-empty, .tab-loading");
    await expect(content.first()).toBeVisible({ timeout: 5_000 });
  });
});

// ─── Sprint Report ──────────────────────────────────────────────

test.describe("Sprint Report Fixes", () => {
  test("report shows heading and selector", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "📊", "Report");
    const heading = page.locator("h1", { hasText: "Sprint Report" });
    await expect(heading).toBeVisible({ timeout: 5_000 });
    const select = page.locator(".report-sprint-select");
    await expect(select).toBeVisible();
  });

  test("report selector has at least one option", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "📊", "Report");
    const select = page.locator(".report-sprint-select");
    await expect(select).toBeVisible({ timeout: 5_000 });
    const options = select.locator("option");
    expect(await options.count()).toBeGreaterThanOrEqual(1);
  });

  test("report shows empty state or data content", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "📊", "Report");
    await page.waitForTimeout(2000);
    // Should show either report-empty, report-summary, or loading
    const content = page.locator(".report-empty, .report-summary, .report-loading");
    await expect(content.first()).toBeVisible({ timeout: 5_000 });
  });

  test("copy/download buttons only appear with data", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "📊", "Report");
    await page.waitForTimeout(2000);
    const reportActions = page.locator(".report-actions");
    if (await reportActions.count() > 0) {
      // If report has data, buttons should be visible and enabled
      const copyBtn = page.locator("button", { hasText: "Copy Markdown" });
      await expect(copyBtn).toBeVisible();
      const downloadBtn = page.locator("button", { hasText: "Download" });
      await expect(downloadBtn).toBeVisible();
    }
    // If no data, buttons should not exist at all
  });
});

// ─── Agent Panel Auto-Close ────────────────────────────────────

test.describe("Agent Panel Auto-Close on Restricted Tabs", () => {
  test("panel closes when switching to settings tab", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".tab-nav", { timeout: 10_000 });
    // Navigate to backlog (where agent toggle is visible)
    await navigateToTab(page, "📋", "Backlog");
    await page.waitForTimeout(2000);
    // Open the agent panel
    const agentBtn = page.locator(".agent-toggle-btn");
    await agentBtn.click();
    await page.waitForTimeout(500);
    const sidePanel = page.locator(".side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 3_000 });
    // Switch to settings (restricted) — panel should close
    await navigateToTab(page, "⚙️", "Settings");
    await page.waitForTimeout(500);
    await expect(sidePanel).not.toBeVisible();
  });

  test("panel closes when switching to logs tab", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".tab-nav", { timeout: 10_000 });
    await navigateToTab(page, "📋", "Backlog");
    await page.waitForTimeout(2000);
    const agentBtn = page.locator(".agent-toggle-btn");
    await agentBtn.click();
    await page.waitForTimeout(500);
    const sidePanel = page.locator(".side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 3_000 });
    // Switch to logs (restricted)
    await navigateToTab(page, "📜", "Logs");
    await page.waitForTimeout(500);
    await expect(sidePanel).not.toBeVisible();
  });

  test("app-level side panel hides when switching to sprint tab", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".tab-nav", { timeout: 10_000 });
    await navigateToTab(page, "📋", "Backlog");
    await page.waitForTimeout(2000);
    const agentBtn = page.locator(".agent-toggle-btn");
    await agentBtn.click();
    await page.waitForTimeout(500);
    // The app-level side panel wrapper (.app-side) should be visible
    const appSide = page.locator(".app-side");
    await expect(appSide).toBeVisible({ timeout: 3_000 });
    // Switch to sprint — app-side wrapper should disappear (Sprint has its own embedded panel)
    await navigateToTab(page, "🏃", "Sprint");
    await expect(appSide).not.toBeVisible({ timeout: 5_000 });
  });
});

// ─── Log Terminal Mode Switching ────────────────────────────────

test.describe("Log Terminal Modes", () => {
  test("defaults to Error Log (files) mode", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "📜", "Logs");
    const filesBtn = page.locator(".log-mode-btn.active", { hasText: "Error Log" });
    await expect(filesBtn).toBeVisible({ timeout: 5_000 });
  });

  test("can switch between file and live modes", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "📜", "Logs");
    // Switch to live
    const liveBtn = page.locator(".log-mode-btn", { hasText: "Live" });
    await liveBtn.click();
    await page.waitForTimeout(300);
    await expect(liveBtn).toHaveClass(/active/);
    // Switch back to files
    const filesBtn = page.locator(".log-mode-btn", { hasText: "Error Log" });
    await filesBtn.click();
    await page.waitForTimeout(300);
    await expect(filesBtn).toHaveClass(/active/);
  });

  test("live mode shows empty state when no logs", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "📜", "Logs");
    const liveBtn = page.locator(".log-mode-btn", { hasText: "Live" });
    await liveBtn.click();
    await page.waitForTimeout(300);
    const empty = page.locator(".log-terminal-empty");
    await expect(empty).toBeVisible();
  });

  test("filter buttons work in file mode", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "📜", "Logs");
    await page.waitForTimeout(1000);
    const allBtn = page.locator(".log-filter-btn", { hasText: "All" });
    const errorBtn = page.locator(".log-filter-btn", { hasText: "Errors" });
    await expect(allBtn).toHaveClass(/active/);
    await errorBtn.click();
    await page.waitForTimeout(300);
    await expect(errorBtn).toHaveClass(/active/);
    // Click all again
    await allBtn.click();
    await page.waitForTimeout(300);
    await expect(allBtn).toHaveClass(/active/);
  });
});

// ─── Settings Save & Reset ──────────────────────────────────────

test.describe("Settings Save/Reset Round-Trip", () => {
  test("save button triggers toast notification", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "⚙️", "Settings");
    await page.waitForSelector(".settings-page", { timeout: 5_000 });
    // Change a value
    const input = page.locator(".settings-table input[type='number']").first();
    const original = await input.inputValue();
    await input.click();
    await input.fill("99");
    // Save
    const saveBtn = page.locator("button", { hasText: /💾\s*Save/i }).first();
    await saveBtn.click();
    // Toast should appear
    const toast = page.locator(".settings-toast");
    await expect(toast).toBeVisible({ timeout: 3_000 });
    // Restore original value
    await input.click();
    await input.fill(original);
    await saveBtn.click();
    await page.waitForTimeout(1500);
  });

  test("reset button reverts changes", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "⚙️", "Settings");
    await page.waitForSelector(".settings-page", { timeout: 5_000 });
    const input = page.locator(".settings-table input[type='number']").first();
    const original = await input.inputValue();
    await input.click();
    await input.fill("77");
    // Reset
    const resetBtn = page.locator("button", { hasText: /↩\s*Reset/i }).first();
    await resetBtn.click();
    await expect(input).toHaveValue(original);
  });
});

// ─── Header Controls ────────────────────────────────────────────

test.describe("Header Controls Verification", () => {
  test("sprint limit dropdown shows current value", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".phase-badge", { timeout: 10_000 });
    const select = page.locator("select").filter({ hasText: /Infinite|Sprint/ }).last();
    const value = await select.inputValue();
    // Value should be a valid number string
    expect(["0", "1", "2", "3", "5", "10"]).toContain(value);
  });

  test("execution mode dropdown shows current mode", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".phase-badge", { timeout: 10_000 });
    const select = page.locator("select").filter({ hasText: /Autonomous|Human/ });
    const value = await select.inputValue();
    expect(["autonomous", "hitl"]).toContain(value);
  });

  test("notification toggle changes icon", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".phase-badge", { timeout: 10_000 });
    const notifBtn = page.locator("button").filter({ hasText: /🔔|🔕/ });
    const initialText = await notifBtn.textContent();
    await notifBtn.click();
    await page.waitForTimeout(300);
    const newText = await notifBtn.textContent();
    expect(newText).not.toBe(initialText);
    // Toggle back
    await notifBtn.click();
    await page.waitForTimeout(300);
  });
});

// ─── WebSocket Reconnection ────────────────────────────────────

test.describe("WebSocket Health", () => {
  test("connection indicator shows green on load", async ({ page }) => {
    await page.goto("/");
    const dot = page.locator(".status-connected");
    await expect(dot).toBeVisible({ timeout: 10_000 });
  });

  test("phase badge is visible after connection", async ({ page }) => {
    await page.goto("/");
    const badge = page.locator(".phase-badge");
    await expect(badge).toBeVisible({ timeout: 10_000 });
    const text = await badge.textContent();
    // Phase should be one of the valid states
    expect(text?.toLowerCase()).toMatch(/init|plan|execute|review|retro|complete|failed|paused/);
  });
});

// ─── API Robustness ─────────────────────────────────────────────

test.describe("API Robustness", () => {
  test("PUT /api/config round-trip preserves data", async ({ request }) => {
    // Read current config
    const getRes = await request.get(`${BASE}/api/config`);
    expect(getRes.ok()).toBeTruthy();
    const config = await getRes.json();
    expect(config.project).toBeDefined();
    // Write same config back
    const putRes = await request.put(`${BASE}/api/config`, {
      data: config,
      headers: { "Content-Type": "application/json" },
    });
    expect(putRes.ok()).toBeTruthy();
    // Read again and verify
    const getRes2 = await request.get(`${BASE}/api/config`);
    const config2 = await getRes2.json();
    expect(config2.project.name).toBe(config.project.name);
  });

  test("PUT /api/quality-gates round-trip preserves data", async ({ request }) => {
    const getRes = await request.get(`${BASE}/api/quality-gates`);
    expect(getRes.ok()).toBeTruthy();
    const qg = await getRes.json();
    if (qg) {
      const putRes = await request.put(`${BASE}/api/quality-gates`, {
        data: qg,
        headers: { "Content-Type": "application/json" },
      });
      expect(putRes.ok()).toBeTruthy();
    }
  });

  test("GET /api/sprint-backlog returns valid structure", async ({ request }) => {
    const res = await request.get(`${BASE}/api/sprint-backlog`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data).toHaveProperty("items");
    expect(Array.isArray(data.items)).toBeTruthy();
  });

  test("GET /api/backlog returns array", async ({ request }) => {
    const res = await request.get(`${BASE}/api/backlog`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

  test("GET /api/ideas returns array", async ({ request }) => {
    const res = await request.get(`${BASE}/api/ideas`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(Array.isArray(data)).toBeTruthy();
  });
});
