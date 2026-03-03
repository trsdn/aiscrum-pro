import { describe, it, expect, vi, beforeEach } from "vitest";
import { SprintEventBus } from "../../src/events.js";
import { attachSprintNotifications } from "../../src/notifications/sprint-notifications.js";
import type { NtfyConfig } from "../../src/notifications/ntfy.js";

// Mock sendNotification
const mockSendNotification = vi.fn();
vi.mock("../../src/notifications/ntfy.js", () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}));

// Mock the logger (transitive dependency)
vi.mock("../../src/logger.js", () => ({
  logger: {
    child: () => ({
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

describe("attachSprintNotifications", () => {
  let bus: SprintEventBus;
  const ntfyConfig: NtfyConfig = {
    enabled: true,
    topic: "test-topic",
    serverUrl: "https://ntfy.sh",
    priority: "default",
  };

  beforeEach(() => {
    bus = new SprintEventBus();
    mockSendNotification.mockReset();
    attachSprintNotifications(bus, ntfyConfig);
  });

  it("sends notification on issue:fail", () => {
    bus.emitTyped("issue:fail", {
      issueNumber: 42,
      reason: "lint failed",
      duration_ms: 1000,
    });

    expect(mockSendNotification).toHaveBeenCalledOnce();
    expect(mockSendNotification).toHaveBeenCalledWith(
      ntfyConfig,
      "Issue Blocked",
      "Issue #42 failed: lint failed",
      "high",
      ["warning"],
    );
  });

  it("sends notification on sprint:complete", () => {
    bus.emitTyped("sprint:complete", { sprintNumber: 5 });

    expect(mockSendNotification).toHaveBeenCalledOnce();
    expect(mockSendNotification).toHaveBeenCalledWith(
      ntfyConfig,
      "Sprint Complete",
      "Sprint 5 finished successfully",
      "default",
      ["tada"],
    );
  });

  it("sends notification on sprint:error", () => {
    bus.emitTyped("sprint:error", { error: "something broke" });

    expect(mockSendNotification).toHaveBeenCalledOnce();
    expect(mockSendNotification).toHaveBeenCalledWith(
      ntfyConfig,
      "Sprint Error",
      "something broke",
      "urgent",
      ["rotating_light"],
    );
  });

  it("subscribes to all three events", () => {
    // Already attached in beforeEach — check all three events trigger calls
    bus.emitTyped("issue:fail", {
      issueNumber: 1,
      reason: "r",
      duration_ms: 0,
    });
    bus.emitTyped("sprint:complete", { sprintNumber: 1 });
    bus.emitTyped("sprint:error", { error: "e" });

    expect(mockSendNotification).toHaveBeenCalledTimes(3);
  });
});
