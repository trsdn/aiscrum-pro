import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SprintRunner, saveState, loadState } from "../src/runner.js";
import type { SprintState } from "../src/runner.js";
import type {
  SprintConfig,
  SprintPlan,
  SprintResult,
  ReviewResult,
  RetroResult,
} from "../src/types.js";
import { SprintEventBus } from "../src/events.js";
import { getNextOpenMilestone, closeMilestone } from "../src/github/milestones.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// --- Mocks ---

vi.mock("../src/acp/client.js", () => ({
  AcpClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../src/ceremonies/planning.js", () => ({
  runSprintPlanning: vi.fn().mockResolvedValue({
    sprintNumber: 1,
    sprint_issues: [
      {
        number: 1,
        title: "Issue 1",
        ice_score: 8,
        depends_on: [],
        acceptanceCriteria: "AC",
        expectedFiles: ["src/a.ts"],
        points: 3,
      },
    ],
    execution_groups: [[1]],
    estimated_points: 3,
    rationale: "Test sprint",
  } satisfies SprintPlan),
}));

vi.mock("../src/ceremonies/parallel-dispatcher.js", () => ({
  runParallelExecution: vi.fn().mockResolvedValue({
    results: [
      {
        issueNumber: 1,
        status: "completed",
        qualityGatePassed: true,
        qualityDetails: { passed: true, checks: [] },
        branch: "feat/1-test",
        duration_ms: 10000,
        filesChanged: ["src/a.ts"],
        retryCount: 0,
        points: 3,
      },
    ],
    sprint: 1,
    parallelizationRatio: 1,
    avgWorktreeLifetime: 10000,
    mergeConflicts: 0,
  } satisfies SprintResult),
}));

vi.mock("../src/ceremonies/review.js", () => ({
  runSprintReview: vi.fn().mockResolvedValue({
    summary: "Good sprint",
    demoItems: ["Feature A"],
    velocityUpdate: "3 points",
    openItems: [],
  } satisfies ReviewResult),
}));

vi.mock("../src/ceremonies/retro.js", () => ({
  runSprintRetro: vi.fn().mockResolvedValue({
    wentWell: ["Good collaboration"],
    wentBadly: ["Slow CI"],
    improvements: [],
    previousImprovementsChecked: true,
  } satisfies RetroResult),
}));

vi.mock("../src/documentation/sprint-log.js", () => ({
  createSprintLog: vi.fn().mockReturnValue("docs/sprints/sprint-1-log.md"),
}));

vi.mock("../src/documentation/velocity.js", () => ({
  appendVelocity: vi.fn(),
}));

vi.mock("../src/metrics.js", () => ({
  calculateSprintMetrics: vi.fn().mockReturnValue({
    planned: 1,
    completed: 1,
    failed: 0,
    pointsPlanned: 3,
    pointsCompleted: 3,
    velocity: 3,
    avgDuration: 10000,
    firstPassRate: 100,
    driftIncidents: 0,
  }),
}));

vi.mock("../src/enforcement/escalation.js", () => ({
  escalateToStakeholder: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/github/milestones.js", () => ({
  getNextOpenMilestone: vi.fn(),
  closeMilestone: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/logger.js", () => {
  const noop = vi.fn();
  const childLogger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: vi.fn().mockReturnThis(),
  };
  return {
    logger: {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      child: vi.fn().mockReturnValue(childLogger),
    },
    createLogger: vi.fn().mockReturnValue(childLogger),
  };
});

// --- Helpers ---

function makeConfig(overrides: Partial<SprintConfig> = {}): SprintConfig {
  return {
    sprintNumber: 1,
    sprintPrefix: "Sprint",
    sprintSlug: "sprint",
    projectPath: os.tmpdir(),
    baseBranch: "main",
    worktreeBase: "../sprint-worktrees",
    branchPattern: "{prefix}/{sprint}/issue-{issue}",
    maxParallelSessions: 4,
    maxIssuesPerSprint: 8,
    maxDriftIncidents: 2,
    maxRetries: 2,
    enableChallenger: false,
    autoRevertDrift: false,
  backlogLabels: [],
    autoMerge: true,
    squashMerge: true,
    deleteBranchAfterMerge: true,
    sessionTimeoutMs: 600000,
    customInstructions: "",
    globalMcpServers: [],
    globalInstructions: [],
    phases: {},
    ...overrides,
  };
}

// --- Tests ---

describe("saveState / loadState", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips state to JSON file", () => {
    const state: SprintState = {
      sprintNumber: 1,
      phase: "plan",
      startedAt: new Date("2025-01-01T00:00:00Z"),
    };
    const filePath = path.join(tmpDir, "state.json");
    saveState(state, filePath);

    const loaded = loadState(filePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.sprintNumber).toBe(1);
    expect(loaded!.phase).toBe("plan");
    expect(loaded!.startedAt).toEqual(new Date("2025-01-01T00:00:00Z"));
  });

  it("creates parent directories if needed", () => {
    const state: SprintState = {
      sprintNumber: 2,
      phase: "init",
      startedAt: new Date(),
    };
    const filePath = path.join(tmpDir, "a", "b", "state.json");
    saveState(state, filePath);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("writes atomically via temp file", () => {
    const state: SprintState = {
      sprintNumber: 1,
      phase: "plan",
      startedAt: new Date(),
    };
    const filePath = path.join(tmpDir, "atomic.json");
    const tmpPath = filePath + ".tmp";

    saveState(state, filePath);

    // Final file exists, .tmp does not linger
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);

    // Content is valid JSON with version
    const loaded = loadState(filePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.phase).toBe("plan");
    expect(loaded!.sprintNumber).toBe(1);
  });

  it("preserves optional fields", () => {
    const state: SprintState = {
      sprintNumber: 1,
      phase: "failed",
      startedAt: new Date(),
      error: "Something went wrong",
    };
    const filePath = path.join(tmpDir, "state.json");
    saveState(state, filePath);

    const loaded = loadState(filePath);
    expect(loaded!.error).toBe("Something went wrong");
    expect(loaded!.phase).toBe("failed");
  });

  it("returns null for corrupt JSON", () => {
    const filePath = path.join(tmpDir, "corrupt.json");
    fs.writeFileSync(filePath, "not json", "utf-8");

    const loaded = loadState(filePath);
    expect(loaded).toBeNull();
  });

  it("returns null for missing required fields", () => {
    const filePath = path.join(tmpDir, "empty.json");
    fs.writeFileSync(filePath, "{}", "utf-8");

    const loaded = loadState(filePath);
    expect(loaded).toBeNull();
  });

  it("returns null for invalid date format", () => {
    const filePath = path.join(tmpDir, "baddate.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        sprintNumber: 1,
        phase: "init",
        startedAt: "not-a-date",
        version: "1",
      }),
      "utf-8",
    );

    const loaded = loadState(filePath);
    expect(loaded).toBeNull();
  });
});

describe("SprintRunner", { timeout: 15000 }, () => {
  let config: SprintConfig;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-test-"));
    config = makeConfig({ projectPath: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("constructor", () => {
    it("initializes with init phase", () => {
      const runner = new SprintRunner(config);
      const state = runner.getState();
      expect(state.phase).toBe("init");
      expect(state.sprintNumber).toBe(1);
      expect(state.startedAt).toBeInstanceOf(Date);
    });
  });

  describe("fullCycle", () => {
    it("runs all phases and returns completed state", async () => {
      const runner = new SprintRunner(config);
      const finalState = await runner.fullCycle();

      expect(finalState.phase).toBe("complete");
      expect(finalState.plan).toBeDefined();
      expect(finalState.result).toBeDefined();
      expect(finalState.review).toBeDefined();
      expect(finalState.retro).toBeDefined();
      expect(finalState.error).toBeUndefined();
    });

    it("creates state file on completion", async () => {
      const runner = new SprintRunner(config);
      await runner.fullCycle();

      const stateFile = path.join(tmpDir, "docs", "sprints", "sprint-1-state.json");
      expect(fs.existsSync(stateFile)).toBe(true);
    });

    it("sets failed phase on error", async () => {
      const { runSprintPlanning } = await import("../src/ceremonies/planning.js");
      vi.mocked(runSprintPlanning).mockRejectedValueOnce(new Error("ACP timeout"));

      const runner = new SprintRunner(config);
      const finalState = await runner.fullCycle();

      expect(finalState.phase).toBe("failed");
      expect(finalState.error).toBe("ACP timeout");
    });

    it("disconnects client even on error", async () => {
      const { AcpClient } = await import("../src/acp/client.js");
      const mockDisconnect = vi.fn().mockResolvedValue(undefined);
      vi.mocked(AcpClient).mockImplementation(
        () =>
          ({
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect: mockDisconnect,
          }) as any,
      );

      const { runSprintPlanning } = await import("../src/ceremonies/planning.js");
      vi.mocked(runSprintPlanning).mockRejectedValueOnce(new Error("fail"));

      const runner = new SprintRunner(config);
      await runner.fullCycle();

      expect(mockDisconnect).toHaveBeenCalled();
    });
  });

  describe("individual phase methods", () => {
    it("runPlan stores plan in state", async () => {
      const runner = new SprintRunner(config);
      await (runner as any).client.connect();

      const plan = await runner.runPlan();
      expect(plan.sprintNumber).toBe(1);
      expect(plan.sprint_issues).toHaveLength(1);

      const state = runner.getState();
      expect(state.plan).toEqual(plan);
    });

    it("runExecute stores result in state", async () => {
      const runner = new SprintRunner(config);
      await (runner as any).client.connect();

      const plan = await runner.runPlan();
      const result = await runner.runExecute(plan);
      expect(result.results).toHaveLength(1);

      const state = runner.getState();
      expect(state.result).toEqual(result);
    });

    it("runReview stores review in state", async () => {
      const runner = new SprintRunner(config);
      await (runner as any).client.connect();

      const plan = await runner.runPlan();
      const result = await runner.runExecute(plan);
      const review = await runner.runReview(result);
      expect(review.summary).toBe("Good sprint");

      const state = runner.getState();
      expect(state.review).toEqual(review);
    });

    it("runRetro stores retro in state", async () => {
      const runner = new SprintRunner(config);
      await (runner as any).client.connect();

      const plan = await runner.runPlan();
      const result = await runner.runExecute(plan);
      const review = await runner.runReview(result);
      const retro = await runner.runRetro(result, review);
      expect(retro.wentWell).toContain("Good collaboration");

      const state = runner.getState();
      expect(state.retro).toEqual(retro);
    });
  });

  describe("state transitions", () => {
    it("ends in complete phase after fullCycle", { timeout: 15000 }, async () => {
      const runner = new SprintRunner(config);
      const finalState = await runner.fullCycle();

      expect(finalState.phase).toBe("complete");
      expect(finalState.plan).toBeDefined();
      expect(finalState.result).toBeDefined();
      expect(finalState.review).toBeDefined();
      expect(finalState.retro).toBeDefined();
    });

    it("state file records final phase", { timeout: 15000 }, async () => {
      const runner = new SprintRunner(config);
      await runner.fullCycle();

      const stateFile = path.join(tmpDir, "docs", "sprints", "sprint-1-state.json");
      const persisted = loadState(stateFile);
      expect(persisted).not.toBeNull();
      expect(persisted!.phase).toBe("complete");
    });
  });

  describe("pause / resume", () => {
    it("sets phase to paused", () => {
      const runner = new SprintRunner(config);
      // Simulate being in a running phase
      (runner as any).state.phase = "execute";
      runner.pause();

      expect(runner.getState().phase).toBe("paused");
    });

    it("resumes to previous phase", () => {
      const runner = new SprintRunner(config);
      (runner as any).state.phase = "execute";
      runner.pause();
      expect(runner.getState().phase).toBe("paused");

      runner.resume();
      expect(runner.getState().phase).toBe("execute");
    });

    it("does not pause if already complete", () => {
      const runner = new SprintRunner(config);
      (runner as any).state.phase = "complete";
      runner.pause();
      expect(runner.getState().phase).toBe("complete");
    });

    it("does not pause if already failed", () => {
      const runner = new SprintRunner(config);
      (runner as any).state.phase = "failed";
      runner.pause();
      expect(runner.getState().phase).toBe("failed");
    });

    it("resume is no-op if not paused", () => {
      const runner = new SprintRunner(config);
      (runner as any).state.phase = "execute";
      runner.resume();
      expect(runner.getState().phase).toBe("execute");
    });

    it("checkPaused blocks until resumed", async () => {
      const runner = new SprintRunner(config);
      (runner as any).state.phase = "execute";
      runner.pause();

      let resolved = false;
      const promise = (runner as any).checkPaused().then(() => {
        resolved = true;
      });

      // Should still be paused after a short wait
      await new Promise((r) => setTimeout(r, 100));
      expect(resolved).toBe(false);

      runner.resume();
      await promise;
      expect(resolved).toBe(true);
    });
  });

  describe("getState", () => {
    it("returns a copy of the state", () => {
      const runner = new SprintRunner(config);
      const state1 = runner.getState();
      const state2 = runner.getState();
      expect(state1).toEqual(state2);
      expect(state1).not.toBe(state2);
    });
  });

  describe("error handling", () => {
    it("handles non-Error throws", async () => {
      const { runSprintPlanning } = await import("../src/ceremonies/planning.js");
      vi.mocked(runSprintPlanning).mockRejectedValueOnce("string error");

      const runner = new SprintRunner(config);
      const finalState = await runner.fullCycle();

      expect(finalState.phase).toBe("failed");
      expect(finalState.error).toBe("string error");
    });

    it("persists state on failure", async () => {
      const { runSprintPlanning } = await import("../src/ceremonies/planning.js");
      vi.mocked(runSprintPlanning).mockRejectedValueOnce(new Error("boom"));

      const runner = new SprintRunner(config);
      await runner.fullCycle();

      const stateFile = path.join(tmpDir, "docs", "sprints", "sprint-1-state.json");
      expect(fs.existsSync(stateFile)).toBe(true);
      const persisted = loadState(stateFile);
      expect(persisted).not.toBeNull();
      expect(persisted!.phase).toBe("failed");
      expect(persisted!.error).toBe("boom");
    });

    it("handles disconnect failure gracefully", async () => {
      const { AcpClient } = await import("../src/acp/client.js");
      vi.mocked(AcpClient).mockImplementation(
        () =>
          ({
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn().mockRejectedValue(new Error("disconnect fail")),
          }) as any,
      );

      const { runSprintPlanning } = await import("../src/ceremonies/planning.js");
      vi.mocked(runSprintPlanning).mockRejectedValueOnce(new Error("boom"));

      const runner = new SprintRunner(config);
      const finalState = await runner.fullCycle();

      // Should still report the original error, not the disconnect error
      expect(finalState.phase).toBe("failed");
      expect(finalState.error).toBe("boom");
    });
  });
});

describe("sprintLoop", { timeout: 30000 }, () => {
  function makeMilestone(n: number) {
    return { sprintNumber: n, milestone: { title: `Sprint ${n}`, number: n, state: "open" } };
  }

  beforeEach(async () => {
    // Reset milestone mocks
    vi.mocked(getNextOpenMilestone).mockReset();
    vi.mocked(closeMilestone).mockReset().mockResolvedValue(undefined);

    // Restore AcpClient — "error handling" tests corrupt it with mockImplementation
    const { AcpClient } = await import("../src/acp/client.js");
    vi.mocked(AcpClient).mockImplementation(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
        }) as any,
    );

    // Restore runSprintPlanning — "error handling" tests add mockRejectedValueOnce
    const { runSprintPlanning } = await import("../src/ceremonies/planning.js");
    vi.mocked(runSprintPlanning).mockResolvedValue({
      sprintNumber: 1,
      sprint_issues: [{ number: 1, title: "Issue 1", estimate: 3 }],
      estimated_points: 3,
      rationale: "test",
    } as any);
  });

  it("runs multiple sprints until no milestones remain", async () => {
    vi.mocked(getNextOpenMilestone)
      .mockResolvedValueOnce(makeMilestone(1))
      .mockResolvedValueOnce(makeMilestone(2))
      .mockResolvedValueOnce(null);
    vi.mocked(closeMilestone).mockResolvedValue(undefined);

    const bus = new SprintEventBus();
    const sprintStarts: number[] = [];
    bus.onTyped("sprint:start", ({ sprintNumber }) => sprintStarts.push(sprintNumber));

    const results = await SprintRunner.sprintLoop(
      (n) => makeConfig({ sprintNumber: n }),
      bus,
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.phase).toBe("complete");
    expect(results[1]!.phase).toBe("complete");
    expect(sprintStarts).toEqual([1, 2]);
    expect(closeMilestone).toHaveBeenCalledTimes(2);
  });

  it("stops after maxSprints is reached", async () => {
    vi.mocked(getNextOpenMilestone)
      .mockResolvedValueOnce(makeMilestone(1))
      .mockResolvedValueOnce(makeMilestone(2))
      .mockResolvedValueOnce(makeMilestone(3));
    vi.mocked(closeMilestone).mockResolvedValue(undefined);

    const bus = new SprintEventBus();
    const results = await SprintRunner.sprintLoop(
      (n) => makeConfig({ sprintNumber: n }),
      bus,
      2,
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.phase).toBe("complete");
    expect(results[1]!.phase).toBe("complete");
    expect(closeMilestone).toHaveBeenCalledTimes(2);
  });

  it("maxSprints=1 runs exactly one sprint", async () => {
    vi.mocked(getNextOpenMilestone).mockResolvedValueOnce(makeMilestone(5));
    vi.mocked(closeMilestone).mockResolvedValue(undefined);

    const results = await SprintRunner.sprintLoop(
      (n) => makeConfig({ sprintNumber: n }),
      undefined,
      1,
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.phase).toBe("complete");
  });

  it("maxSprints=0 means infinite (stops only when no milestones)", async () => {
    vi.mocked(getNextOpenMilestone)
      .mockResolvedValueOnce(makeMilestone(1))
      .mockResolvedValueOnce(null);
    vi.mocked(closeMilestone).mockResolvedValue(undefined);

    const results = await SprintRunner.sprintLoop(
      (n) => makeConfig({ sprintNumber: n }),
      undefined,
      0,
    );

    expect(results).toHaveLength(1);
  });

  it("stops loop on sprint failure", async () => {
    vi.mocked(getNextOpenMilestone)
      .mockResolvedValueOnce(makeMilestone(1))
      .mockResolvedValueOnce(makeMilestone(2));
    vi.mocked(closeMilestone).mockResolvedValue(undefined);

    const { runSprintPlanning } = await import("../src/ceremonies/planning.js");
    vi.mocked(runSprintPlanning).mockRejectedValueOnce(new Error("ACP down"));

    const bus = new SprintEventBus();
    const results = await SprintRunner.sprintLoop(
      (n) => makeConfig({ sprintNumber: n }),
      bus,
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.phase).toBe("failed");
    expect(closeMilestone).not.toHaveBeenCalled();
    expect(getNextOpenMilestone).toHaveBeenCalledTimes(1);
  });

  it("emits log events for sprint transitions", async () => {
    vi.mocked(getNextOpenMilestone)
      .mockResolvedValueOnce(makeMilestone(1))
      .mockResolvedValueOnce(null);
    vi.mocked(closeMilestone).mockResolvedValue(undefined);

    const bus = new SprintEventBus();
    const logs: string[] = [];
    bus.onTyped("log", ({ message }) => logs.push(message));

    await SprintRunner.sprintLoop(
      (n) => makeConfig({ sprintNumber: n }),
      bus,
    );

    expect(logs.some((m) => m.includes("Starting Sprint 1"))).toBe(true);
    expect(logs.some((m) => m.includes("No open sprint milestones"))).toBe(true);
  });

  it("emits log when sprint limit reached", async () => {
    vi.mocked(getNextOpenMilestone)
      .mockResolvedValueOnce(makeMilestone(1))
      .mockResolvedValueOnce(makeMilestone(2));
    vi.mocked(closeMilestone).mockResolvedValue(undefined);

    const bus = new SprintEventBus();
    const logs: string[] = [];
    bus.onTyped("log", ({ message }) => logs.push(message));

    await SprintRunner.sprintLoop(
      (n) => makeConfig({ sprintNumber: n }),
      bus,
      1,
    );

    expect(logs.some((m) => m.includes("Sprint limit reached"))).toBe(true);
  });
});
