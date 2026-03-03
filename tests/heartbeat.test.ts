import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { HeartbeatSupervisor, type HeartbeatConfig } from "../src/heartbeat.js";
import { SprintEventBus } from "../src/events.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-test-"));
}

function writeState(dir: string, num: number, phase: string, slug = "sprint"): void {
  fs.writeFileSync(
    path.join(dir, `${slug}-${num}-state.json`),
    JSON.stringify({ sprintNumber: num, phase, startedAt: new Date().toISOString() }),
  );
}

function writeLock(dir: string, num: number, pid: number, slug = "sprint"): void {
  fs.writeFileSync(path.join(dir, `${slug}-${num}-state.json.lock`), String(pid));
}

describe("HeartbeatSupervisor", () => {
  let tmpDir: string;
  let bus: SprintEventBus;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    bus = new SprintEventBus();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(overrides: Partial<HeartbeatConfig> = {}): HeartbeatConfig {
    return {
      enabled: true,
      intervalMs: 60000,
      staleThresholdMs: 300000,
      stateDir: tmpDir,
      sprintSlug: "sprint",
      ...overrides,
    };
  }

  it("emits heartbeat:tick with null sprint when no state files exist", async () => {
    const supervisor = new HeartbeatSupervisor(makeConfig(), bus);
    const ticks: unknown[] = [];
    bus.onTyped("heartbeat:tick", (p) => ticks.push(p));

    const result = await supervisor.tick();
    expect(result.sprintNumber).toBeNull();
    expect(result.phase).toBeNull();
    expect(result.healthy).toBe(true);
    expect(ticks).toHaveLength(1);
  });

  it("reads the latest sprint state file", async () => {
    writeState(tmpDir, 1, "complete");
    writeState(tmpDir, 2, "execute");

    const supervisor = new HeartbeatSupervisor(makeConfig(), bus);
    const result = await supervisor.tick();

    expect(result.sprintNumber).toBe(2);
    expect(result.phase).toBe("execute");
  });

  it("detects and cleans orphaned lock files", async () => {
    // Use a PID that definitely doesn't exist
    writeLock(tmpDir, 1, 999999999);

    const recovered: unknown[] = [];
    bus.onTyped("heartbeat:recovered", (p) => recovered.push(p));

    const supervisor = new HeartbeatSupervisor(makeConfig(), bus);
    const result = await supervisor.tick();

    expect(result.staleLock).toBe(true);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ action: "orphaned_lock_cleaned" });
    // Lock file should be removed
    expect(fs.existsSync(path.join(tmpDir, "sprint-1-state.json.lock"))).toBe(false);
  });

  it("does not remove lock for running process", async () => {
    // Use our own PID — it's alive
    writeLock(tmpDir, 1, process.pid);

    const supervisor = new HeartbeatSupervisor(makeConfig(), bus);
    const result = await supervisor.tick();

    expect(result.staleLock).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "sprint-1-state.json.lock"))).toBe(true);
  });

  it("reports healthy=true for complete phase", async () => {
    writeState(tmpDir, 1, "complete");
    const supervisor = new HeartbeatSupervisor(makeConfig(), bus);
    const result = await supervisor.tick();
    expect(result.healthy).toBe(true);
  });

  it("reports healthy=false for failed phase", async () => {
    writeState(tmpDir, 1, "failed");
    const supervisor = new HeartbeatSupervisor(makeConfig(), bus);
    const result = await supervisor.tick();
    expect(result.healthy).toBe(false);
  });

  it("reports healthy=false for stopped phase", async () => {
    writeState(tmpDir, 1, "stopped");
    const supervisor = new HeartbeatSupervisor(makeConfig(), bus);
    const result = await supervisor.tick();
    expect(result.healthy).toBe(false);
  });

  it("emits heartbeat:stale when phase unchanged beyond threshold", async () => {
    writeState(tmpDir, 1, "execute");

    const staleEvents: unknown[] = [];
    bus.onTyped("heartbeat:stale", (p) => staleEvents.push(p));

    const supervisor = new HeartbeatSupervisor(
      makeConfig({ staleThresholdMs: 0 }), // immediate stale threshold
      bus,
    );

    // First tick sets initial phase
    await supervisor.tick();
    // Small delay so Date.now() advances past threshold
    await new Promise((r) => setTimeout(r, 5));
    // Second tick should detect stale (threshold = 0ms)
    await supervisor.tick();

    expect(staleEvents).toHaveLength(1);
    expect(staleEvents[0]).toMatchObject({ sprintNumber: 1, phase: "execute" });
  });

  it("does not emit stale for complete/failed/stopped phases", async () => {
    writeState(tmpDir, 1, "complete");
    const staleEvents: unknown[] = [];
    bus.onTyped("heartbeat:stale", (p) => staleEvents.push(p));

    const supervisor = new HeartbeatSupervisor(
      makeConfig({ staleThresholdMs: 0 }),
      bus,
    );
    await supervisor.tick();
    await supervisor.tick();

    expect(staleEvents).toHaveLength(0);
  });

  it("start and stop manage the timer", () => {
    vi.useFakeTimers();
    const supervisor = new HeartbeatSupervisor(makeConfig({ intervalMs: 1000 }), bus);

    const ticks: unknown[] = [];
    bus.onTyped("heartbeat:tick", (p) => ticks.push(p));

    supervisor.start();
    // Initial tick fires immediately
    expect(ticks.length).toBeGreaterThanOrEqual(1);

    supervisor.stop();
    vi.useRealTimers();
  });

  it("does not start when disabled", () => {
    const supervisor = new HeartbeatSupervisor(makeConfig({ enabled: false }), bus);
    const ticks: unknown[] = [];
    bus.onTyped("heartbeat:tick", (p) => ticks.push(p));

    supervisor.start();
    expect(ticks).toHaveLength(0);
    supervisor.stop();
  });

  it("handles invalid lock file content", async () => {
    fs.writeFileSync(path.join(tmpDir, "sprint-1-state.json.lock"), "not-a-number");

    const supervisor = new HeartbeatSupervisor(makeConfig(), bus);
    const result = await supervisor.tick();

    expect(result.staleLock).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "sprint-1-state.json.lock"))).toBe(false);
  });
});
