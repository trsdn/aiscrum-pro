/**
 * E2E tests for sprint control buttons: Start, Pause, Resume, Stop
 * and related header controls (mode selector, sprint limit).
 */
import { test, expect, type Page } from "@playwright/test";

const BASE = "http://localhost:9200";

// Helper: wait for dashboard to load
async function waitForDashboard(page: Page) {
  await page.goto("/");
  await page.waitForSelector(".phase-badge", { timeout: 10_000 });
  await page.waitForTimeout(1000);
}

// ─── Sprint Control Buttons ────────────────────────────────────

test.describe("Sprint Control Buttons", () => {
  test("Start button is visible and enabled in INIT/FAILED phase", async ({ page }) => {
    await waitForDashboard(page);
    await page.waitForTimeout(3000);
    const phaseBadge = page.locator(".phase-badge");
    const phaseText = await phaseBadge.textContent();

    if (phaseText === "INIT" || phaseText === "COMPLETE" || phaseText === "FAILED") {
      const startBtn = page.locator("button", { hasText: "▶ Start" });
      await expect(startBtn).toBeVisible();
      // Start button should always be enabled when idle (no sprint running)
      await expect(startBtn).toBeEnabled();
    }
  });

  test("Start button has correct class", async ({ page }) => {
    await waitForDashboard(page);
    const startBtn = page.locator("button.btn-primary", { hasText: "Start" });
    if (await startBtn.count() > 0) {
      await expect(startBtn).toHaveClass(/btn-primary/);
    }
  });

  test("Pause button is NOT visible in INIT phase", async ({ page }) => {
    await waitForDashboard(page);
    const phaseText = await page.locator(".phase-badge").textContent();
    if (phaseText === "INIT") {
      const pauseBtn = page.locator("button", { hasText: "⏸ Pause" });
      await expect(pauseBtn).toHaveCount(0);
    }
  });

  test("Resume button is NOT visible in INIT phase", async ({ page }) => {
    await waitForDashboard(page);
    const phaseText = await page.locator(".phase-badge").textContent();
    if (phaseText === "INIT") {
      const resumeBtn = page.locator("button", { hasText: "▶ Resume" });
      await expect(resumeBtn).toHaveCount(0);
    }
  });

  test("Start button is always enabled when idle (no sprint running)", async ({ page }) => {
    await waitForDashboard(page);
    await page.waitForTimeout(3000);
    const startBtn = page.locator("button", { hasText: "▶ Start" });
    if (await startBtn.count() > 0) {
      // When idle, Start should always be enabled regardless of which sprint is viewed
      await expect(startBtn).toBeEnabled();
    }
  });

  test("Stop button is NOT visible in INIT phase", async ({ page }) => {
    await waitForDashboard(page);
    const phaseText = await page.locator(".phase-badge").textContent();
    if (phaseText === "INIT") {
      const stopBtn = page.locator("button", { hasText: "⏹ Stop" });
      await expect(stopBtn).toHaveCount(0);
    }
  });

  test("clicking Start sends sprint:start message via WebSocket", async ({ page }) => {
    await waitForDashboard(page);
    const startBtn = page.locator("button", { hasText: "▶ Start" });
    if (await startBtn.count() > 0 && await startBtn.isEnabled()) {
      // Set up WebSocket message listener
      const wsMessages: string[] = [];
      await page.evaluate(() => {
        const origSend = WebSocket.prototype.send;
        (window as unknown as Record<string, string[]>).__wsMsgs = [];
        WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          if (typeof data === "string") {
            (window as unknown as Record<string, string[]>).__wsMsgs.push(data);
          }
          return origSend.call(this, data);
        };
      });

      await startBtn.click();
      await page.waitForTimeout(500);

      const messages = await page.evaluate(() => (window as unknown as Record<string, string[]>).__wsMsgs);
      const startMsg = messages.find((m: string) => m.includes("sprint:start"));
      expect(startMsg).toBeDefined();
      const parsed = JSON.parse(startMsg!);
      expect(parsed.type).toBe("sprint:start");
    }
  });
});

// ─── Execution Mode Selector ───────────────────────────────────

test.describe("Execution Mode Selector", () => {
  test("mode selector is visible", async ({ page }) => {
    await waitForDashboard(page);
    const modeSelect = page.locator("select").filter({ hasText: /Autonomous|Human/ });
    await expect(modeSelect).toBeVisible();
  });

  test("can switch between execution modes", async ({ page }) => {
    await waitForDashboard(page);
    const modeSelect = page.locator("select").filter({ hasText: /Autonomous|Human/ });
    // Switch to hitl
    await modeSelect.selectOption("hitl");
    expect(await modeSelect.inputValue()).toBe("hitl");
    // Switch back to autonomous
    await modeSelect.selectOption("autonomous");
    expect(await modeSelect.inputValue()).toBe("autonomous");
  });

  test("switching mode sends mode:set message", async ({ page }) => {
    await waitForDashboard(page);

    await page.evaluate(() => {
      const origSend = WebSocket.prototype.send;
      (window as unknown as Record<string, string[]>).__wsMsgs = [];
      WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === "string") {
          (window as unknown as Record<string, string[]>).__wsMsgs.push(data);
        }
        return origSend.call(this, data);
      };
    });

    const modeSelect = page.locator("select").filter({ hasText: /Autonomous|Human/ });
    await modeSelect.selectOption("hitl");
    await page.waitForTimeout(500);

    const messages = await page.evaluate(() => (window as unknown as Record<string, string[]>).__wsMsgs);
    const modeMsg = messages.find((m: string) => m.includes("mode:set"));
    expect(modeMsg).toBeDefined();
    const parsed = JSON.parse(modeMsg!);
    expect(parsed.type).toBe("mode:set");
    expect(parsed.mode).toBe("hitl");

    // Reset back to autonomous
    await modeSelect.selectOption("autonomous");
  });
});

// ─── Sprint Limit Selector ─────────────────────────────────────

test.describe("Sprint Limit Selector", () => {
  test("sprint limit selector is visible", async ({ page }) => {
    await waitForDashboard(page);
    const limitSelect = page.locator("select").filter({ hasText: /Infinite|Sprint/ });
    await expect(limitSelect).toBeVisible();
  });

  test("can change sprint limit", async ({ page }) => {
    await waitForDashboard(page);
    const limitSelect = page.locator("select").filter({ hasText: /Infinite|Sprint/ });
    await limitSelect.selectOption("1");
    expect(await limitSelect.inputValue()).toBe("1");
    // Reset
    await limitSelect.selectOption("0");
    expect(await limitSelect.inputValue()).toBe("0");
  });

  test("changing limit sends sprint:set-limit message", async ({ page }) => {
    await waitForDashboard(page);

    await page.evaluate(() => {
      const origSend = WebSocket.prototype.send;
      (window as unknown as Record<string, string[]>).__wsMsgs = [];
      WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === "string") {
          (window as unknown as Record<string, string[]>).__wsMsgs.push(data);
        }
        return origSend.call(this, data);
      };
    });

    const limitSelect = page.locator("select").filter({ hasText: /Infinite|Sprint/ });
    await limitSelect.selectOption("3");
    await page.waitForTimeout(500);

    const messages = await page.evaluate(() => (window as unknown as Record<string, string[]>).__wsMsgs);
    const limitMsg = messages.find((m: string) => m.includes("sprint:set-limit"));
    expect(limitMsg).toBeDefined();
    const parsed = JSON.parse(limitMsg!);
    expect(parsed.type).toBe("sprint:set-limit");
    expect(parsed.limit).toBe(3);

    // Reset
    await limitSelect.selectOption("0");
  });

  test("all sprint limit options exist", async ({ page }) => {
    await waitForDashboard(page);
    const limitSelect = page.locator("select").filter({ hasText: /Infinite|Sprint/ });
    const options = limitSelect.locator("option");
    const values = await options.allTextContents();
    expect(values).toContain("∞ Infinite");
    expect(values).toContain("1 Sprint");
    expect(values).toContain("2 Sprints");
    expect(values).toContain("3 Sprints");
    expect(values).toContain("5 Sprints");
    expect(values).toContain("10 Sprints");
  });
});

// ─── Phase Stepper ─────────────────────────────────────────────

test.describe("Phase Stepper", () => {
  test("phase stepper shows all phases", async ({ page }) => {
    await waitForDashboard(page);
    const stepper = page.locator(".phase-stepper");
    await expect(stepper).toBeVisible();
    const steps = stepper.locator(".step");
    const texts = await steps.allTextContents();
    expect(texts).toEqual(["Plan", "Execute", "Review", "Retro", "Complete"]);
  });

  test("INIT phase has no active step", async ({ page }) => {
    await waitForDashboard(page);
    const phaseText = await page.locator(".phase-badge").textContent();
    if (phaseText === "INIT") {
      // In INIT, no step should be active since INIT isn't in the stepper
      const activeSteps = page.locator(".step-active");
      await expect(activeSteps).toHaveCount(0);
    }
  });

  test("phase badge text matches header state", async ({ page }) => {
    await waitForDashboard(page);
    const badge = page.locator(".phase-badge");
    const text = await badge.textContent();
    // Phase should be one of the known values
    expect(["INIT", "PLAN", "EXECUTE", "REVIEW", "RETRO", "COMPLETE", "FAILED", "PAUSED"]).toContain(text);
  });
});

// ─── Issue Counter ─────────────────────────────────────────────

test.describe("Issue Counter", () => {
  test("issue counter is visible", async ({ page }) => {
    await waitForDashboard(page);
    const counter = page.locator(".issue-count");
    await expect(counter).toBeVisible();
    const text = await counter.textContent();
    // Should match pattern "N/M done"
    expect(text).toMatch(/\d+\/\d+ done/);
  });
});

// ─── Elapsed Timer ─────────────────────────────────────────────

test.describe("Elapsed Timer", () => {
  test("elapsed timer is visible", async ({ page }) => {
    await waitForDashboard(page);
    const elapsed = page.locator(".elapsed");
    await expect(elapsed).toBeVisible();
    const text = await elapsed.textContent();
    expect(text).toMatch(/\d+m \d+s/);
  });
});

// ─── Connection Status ─────────────────────────────────────────

test.describe("Connection Status", () => {
  test("connection dot is visible", async ({ page }) => {
    await waitForDashboard(page);
    const dot = page.locator(".status-dot");
    await expect(dot).toBeVisible();
  });

  test("connection dot shows connected state", async ({ page }) => {
    await waitForDashboard(page);
    const dot = page.locator(".status-dot");
    await expect(dot).toHaveClass(/status-connected/);
  });
});

// ─── Notification Toggle ───────────────────────────────────────

test.describe("Notification Toggle", () => {
  test("notification button is visible", async ({ page }) => {
    await waitForDashboard(page);
    const btn = page.locator("button").filter({ hasText: /🔔|🔕/ });
    await expect(btn).toBeVisible();
  });

  test("clicking notification button toggles icon", async ({ page }) => {
    await waitForDashboard(page);
    const btn = page.locator("button").filter({ hasText: /🔔|🔕/ });
    const initialText = await btn.textContent();
    await btn.click();
    await page.waitForTimeout(300);
    const newText = await btn.textContent();
    // Should toggle between 🔔 and 🔕
    expect(newText).not.toBe(initialText);
    // Toggle back
    await btn.click();
    await page.waitForTimeout(300);
    const restoredText = await btn.textContent();
    expect(restoredText).toBe(initialText);
  });
});
