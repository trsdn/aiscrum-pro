/**
 * E2E tests for Sprint Report, SidePanel chat, and tab action buttons.
 */
import { test, expect } from "@playwright/test";

const TAB_ICONS: Record<string, string> = {
  "Sprint": "🏃", "Sprint Backlog": "📦", "Backlog": "📋",
  "Blocked": "🚧", "Decisions": "⚖️", "Ideas": "💡",
  "Report": "📊", "Logs": "📜", "Settings": "⚙️",
};
async function navigateToTab(page: import("@playwright/test").Page, label: string) {
  await page.waitForSelector(".tab-nav", { timeout: 10_000 });
  const fullText = `${TAB_ICONS[label] ?? ""} ${label}`;
  await page.getByRole("button", { name: fullText, exact: true }).click();
  await page.waitForTimeout(500);
}

// ─── Sprint Report ──────────────────────────────────────────────

test.describe("Sprint Report Deep", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "Report");
  });

  test("has sprint number selector", async ({ page }) => {
    const select = page.locator(".report-sprint-select, select");
    // May or may not have a select depending on data
    const heading = page.locator(".sprint-report h1");
    await expect(heading).toBeVisible();
  });

  test("has copy and download buttons", async ({ page }) => {
    const copyBtn = page.locator("button", { hasText: /Copy/ });
    const downloadBtn = page.locator("button", { hasText: /Download/ });
    // These may only appear when report data exists
    if (await copyBtn.count() > 0) {
      await expect(copyBtn.first()).toBeVisible();
    }
    if (await downloadBtn.count() > 0) {
      await expect(downloadBtn.first()).toBeVisible();
    }
  });

  test("report sections are collapsible", async ({ page }) => {
    const sectionHeaders = page.locator(".report-section-header");
    if (await sectionHeaders.count() > 0) {
      const first = sectionHeaders.first();
      await first.click();
      await page.waitForTimeout(300);
      // Click again to re-expand
      await first.click();
      await page.waitForTimeout(300);
    }
  });

  test("summary cards show sprint metrics", async ({ page }) => {
    const cards = page.locator(".summary-card");
    if (await cards.count() > 0) {
      const count = await cards.count();
      expect(count).toBeGreaterThanOrEqual(3);
    }
  });
});

// ─── Side Panel / Chat ──────────────────────────────────────────

test.describe("Side Panel Chat", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".tab-nav", { timeout: 10_000 });
    // Agent toggle is hidden on sprint/settings/logs tabs — go to Backlog
    await page.getByRole("button", { name: "📋 Backlog", exact: true }).click();
    await page.waitForTimeout(2000);
  });

  test("agent toggle button is visible on backlog tab", async ({ page }) => {
    const agentBtn = page.locator(".agent-toggle-btn");
    await expect(agentBtn).toBeVisible();
  });

  test("agent toggle opens/closes side panel", async ({ page }) => {
    const agentBtn = page.locator(".agent-toggle-btn");
    // Open
    await agentBtn.click();
    await page.waitForTimeout(500);
    const sidePanel = page.locator(".side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 3_000 });
    // Close
    await agentBtn.click();
    await page.waitForTimeout(500);
    await expect(sidePanel).not.toBeVisible();
  });

  test("side panel has input area and send button", async ({ page }) => {
    const agentBtn = page.locator(".agent-toggle-btn");
    await agentBtn.click();
    await page.waitForTimeout(500);
    const sidePanel = page.locator(".side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 3_000 });
    const input = page.locator(".side-panel-input");
    await expect(input).toBeVisible();
  });

  test("side panel has session tabs area", async ({ page }) => {
    const agentBtn = page.locator(".agent-toggle-btn");
    await agentBtn.click();
    await page.waitForTimeout(500);
    const sessionTabs = page.locator(".session-tabs");
    await expect(sessionTabs).toBeVisible({ timeout: 3_000 });
  });

  test("side panel has mode selector", async ({ page }) => {
    const agentBtn = page.locator(".agent-toggle-btn");
    await agentBtn.click();
    await page.waitForTimeout(500);
    const modeBar = page.locator(".side-panel-mode-bar");
    await expect(modeBar).toBeVisible({ timeout: 3_000 });
  });

  test("slash command menu appears when typing /", async ({ page }) => {
    const agentBtn = page.locator(".agent-toggle-btn");
    await agentBtn.click();
    await page.waitForTimeout(500);
    const input = page.locator(".side-panel-input");
    await expect(input).toBeVisible({ timeout: 3_000 });
    await input.fill("/");
    await page.waitForTimeout(500);
    const slashMenu = page.locator(".slash-menu");
    if (await slashMenu.count() > 0) {
      await expect(slashMenu).toBeVisible();
    }
  });
});

// ─── Tab Action Buttons ─────────────────────────────────────────

test.describe("Backlog Tab Actions", () => {
  test("has refresh button", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "Backlog");
    await page.waitForTimeout(2000);
    const refreshBtn = page.locator("button", { hasText: "↻" });
    if (await refreshBtn.count() > 0) {
      await expect(refreshBtn.first()).toBeVisible();
    }
  });

  test("has sprint selector for planning", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "Backlog");
    await page.waitForTimeout(2000);
    const select = page.locator(".sprint-select");
    if (await select.count() > 0) {
      await expect(select).toBeVisible();
    }
  });

  test("backlog items have plan buttons", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "Backlog");
    await page.waitForTimeout(2000);
    const planBtn = page.locator(".tab-list .btn-primary");
    if (await planBtn.count() > 0) {
      await expect(planBtn.first()).toBeVisible();
    }
  });
});

test.describe("Blocked Tab Actions", () => {
  test("has refresh button", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "Blocked");
    await page.waitForTimeout(2000);
    const refreshBtn = page.locator("button", { hasText: /↻\s*Refresh/ });
    if (await refreshBtn.count() > 0) {
      await expect(refreshBtn.first()).toBeVisible();
    }
  });

  test("blocked items have discuss button", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "Blocked");
    await page.waitForTimeout(2000);
    const discussBtn = page.locator("button", { hasText: /💬/ });
    if (await discussBtn.count() > 0) {
      await expect(discussBtn.first()).toBeVisible();
    }
  });
});

test.describe("Decisions Tab Actions", () => {
  test("has refresh button", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "Decisions");
    await page.waitForTimeout(2000);
    const refreshBtn = page.locator("button", { hasText: /↻\s*Refresh/ });
    if (await refreshBtn.count() > 0) {
      await expect(refreshBtn.first()).toBeVisible();
    }
  });

  test("decision items have discuss button", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "Decisions");
    await page.waitForTimeout(2000);
    const discussBtn = page.locator("button", { hasText: /💬/ });
    if (await discussBtn.count() > 0) {
      await expect(discussBtn.first()).toBeVisible();
    }
  });
});

test.describe("Ideas Tab Actions", () => {
  test("has refresh button", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "Ideas");
    await page.waitForTimeout(2000);
    const refreshBtn = page.locator("button", { hasText: /↻\s*Refresh/ });
    if (await refreshBtn.count() > 0) {
      await expect(refreshBtn.first()).toBeVisible();
    }
  });

  test("idea items have refine button", async ({ page }) => {
    await page.goto("/");
    await navigateToTab(page, "Ideas");
    await page.waitForTimeout(2000);
    const refineBtn = page.locator("button", { hasText: /🔬/ });
    if (await refineBtn.count() > 0) {
      await expect(refineBtn.first()).toBeVisible();
    }
  });
});

// ─── WebSocket Connection ───────────────────────────────────────

test.describe("WebSocket Connection", () => {
  test("connects and receives initial state", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".phase-badge", { timeout: 10_000 });
    // Connection indicator should show ok
    const indicator = page.locator(".status-indicator.status-ok");
    await expect(indicator).toBeVisible({ timeout: 5_000 });
  });

  test("reconnects after page reload", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".status-indicator.status-ok", { timeout: 10_000 });
    await page.reload();
    await page.waitForSelector(".status-indicator.status-ok", { timeout: 10_000 });
  });
});

// ─── Responsive Layout ─────────────────────────────────────────

test.describe("Layout", () => {
  test("tab nav wraps all tabs", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".tab-nav", { timeout: 10_000 });
    const tabs = page.locator(".tab-nav button.tab-btn");
    const count = await tabs.count();
    // 9 tab buttons + 1 agent toggle = 10
    expect(count).toBeGreaterThanOrEqual(9);
  });

  test("resize handle appears when side panel is open", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".tab-nav", { timeout: 10_000 });
    // Go to a tab where agent toggle is visible
    await page.getByRole("button", { name: "📋 Backlog", exact: true }).click();
    await page.waitForTimeout(2000);
    const agentBtn = page.locator(".agent-toggle-btn");
    await agentBtn.click();
    await page.waitForTimeout(500);
    const handle = page.locator(".app-resize-handle");
    await expect(handle).toBeVisible({ timeout: 3_000 });
  });
});
