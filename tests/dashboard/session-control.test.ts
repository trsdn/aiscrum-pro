import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/logger.js", () => {
  const noop = vi.fn();
  return { logger: { child: () => ({ info: noop, warn: noop, error: noop, debug: noop }) }, appendErrorLog: noop, getErrorLogDir: () => undefined };
});

import { SessionController } from "../../src/dashboard/session-control.js";

describe("SessionController", () => {
  let ctrl: SessionController;

  beforeEach(() => {
    ctrl = new SessionController();
  });

  it("enqueue and drain messages", () => {
    ctrl.enqueue("s1", "hello");
    ctrl.enqueue("s1", "world");
    expect(ctrl.hasPending("s1")).toBe(true);

    const msgs = ctrl.drain("s1");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.content).toBe("hello");
    expect(msgs[1]!.content).toBe("world");
    expect(msgs[0]!.type).toBe("user-message");
    expect(ctrl.hasPending("s1")).toBe(false);
  });

  it("drain returns empty for unknown session", () => {
    expect(ctrl.drain("unknown")).toEqual([]);
  });

  it("stop signal lifecycle", () => {
    expect(ctrl.shouldStop("s1")).toBe(false);
    ctrl.requestStop("s1");
    expect(ctrl.shouldStop("s1")).toBe(true);
    expect(ctrl.shouldStop("s1")).toBe(false); // cleared after check
  });

  it("cleanup removes queue and stop signal", () => {
    ctrl.enqueue("s1", "test");
    ctrl.requestStop("s1");
    ctrl.cleanup("s1");
    expect(ctrl.hasPending("s1")).toBe(false);
    expect(ctrl.shouldStop("s1")).toBe(false);
  });

  it("getActiveSessions returns sessions with pending messages", () => {
    ctrl.enqueue("s1", "a");
    ctrl.enqueue("s2", "b");
    expect(ctrl.getActiveSessions()).toContain("s1");
    expect(ctrl.getActiveSessions()).toContain("s2");
    ctrl.drain("s1");
    expect(ctrl.getActiveSessions()).not.toContain("s1");
  });
});
