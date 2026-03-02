import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SprintConfig, SprintResult, ReviewResult } from "../../src/types.js";

// --- Mocks ---

vi.mock("../../src/acp/session-config.js", () => ({
  resolveSessionConfig: vi.fn().mockResolvedValue({
    mcpServers: [],
    instructions: "",
    model: undefined,
  }),
}));

vi.mock("../../src/metrics.js", () => ({
  calculateSprintMetrics: vi.fn().mockReturnValue({
    planned: 2,
    completed: 2,
    failed: 0,
    completionRate: 1.0,
    totalPoints: 5,
    completedPoints: 5,
    avgCycleTime: 120,
  }),
}));

vi.mock("../../src/documentation/velocity.js", () => ({
  readVelocity: vi.fn().mockReturnValue([]),
}));

vi.mock("../../src/github/issues.js", () => ({
  createIssue: vi.fn().mockResolvedValue({ number: 999, title: "mock" }),
}));

vi.mock("../../src/logger.js", () => {
  const noop = vi.fn();
  const childLogger = {
    info: noop,
    debug: noop,
    warn: noop,
    error: noop,
    child: () => childLogger,
  };
  return { logger: childLogger };
});

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn().mockImplementation((filePath: string) => {
      if (filePath.includes("sprint-runner.config")) {
        return Promise.resolve("sprintNumber: 3");
      }
      if (filePath.includes("retro.md")) {
        return Promise.resolve(
          "Retro for sprint {{SPRINT_NUMBER}} project {{PROJECT_NAME}} diagnostics {{FAILURE_DIAGNOSTICS}}",
        );
      }
      // Previous retro file — reject by default (tests override as needed)
      return Promise.reject(new Error("ENOENT: no such file"));
    }),
  },
}));

const { runSprintRetro } = await import("../../src/ceremonies/retro.js");
const { logger } = await import("../../src/logger.js");

// --- Helpers ---

function makeConfig(overrides: Partial<SprintConfig> = {}): SprintConfig {
  return {
    sprintNumber: 3,
    sprintPrefix: "Sprint",
    sprintSlug: "sprint",
    projectPath: "/tmp/test-project",
    baseBranch: "main",
    worktreeBase: "/tmp/worktrees",
    branchPattern: "{prefix}/{sprint}/issue-{issue}",
    maxParallelSessions: 2,
    maxIssuesPerSprint: 5,
    maxDriftIncidents: 2,
    maxRetries: 1,
    enableChallenger: false,
    autoRevertDrift: false,
    backlogLabels: [],
    autoMerge: true,
    squashMerge: true,
    deleteBranchAfterMerge: true,
    sessionTimeoutMs: 60000,
    customInstructions: "",
    globalMcpServers: [],
    globalInstructions: [],
    phases: {},
    ...overrides,
  };
}

function makeSprintResult(overrides: Partial<SprintResult> = {}): SprintResult {
  return {
    sprint: 3,
    results: [
      {
        issueNumber: 10,
        status: "completed",
        points: 3,
        branch: "sprint/3/issue-10",
        qualityGatePassed: true,
        qualityDetails: { passed: true, checks: [] },
        filesChanged: ["src/api.ts"],
        retryCount: 0,
      },
      {
        issueNumber: 11,
        status: "failed",
        points: 2,
        branch: "sprint/3/issue-11",
        qualityGatePassed: false,
        qualityDetails: {
          passed: false,
          checks: [
            { name: "tests-pass", passed: false, detail: "3 tests failed", category: "test" },
            { name: "lint-clean", passed: true, detail: "Clean", category: "lint" },
          ],
        },
        filesChanged: [],
        retryCount: 2,
      },
    ],
    parallelizationRatio: 1.0,
    avgWorktreeLifetime: 120,
    mergeConflicts: 0,
    ...overrides,
  };
}

function makeReviewResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    summary: "Sprint 3 delivered search endpoint",
    demoItems: ["Search API"],
    velocityUpdate: "On track",
    openItems: [],
    ...overrides,
  };
}

const retroResponse = {
  wentWell: ["Fast delivery", "Good test coverage"],
  wentBadly: ["Flaky CI"],
  improvements: [
    {
      title: "Stabilize CI",
      description: "Add retry logic for flaky tests",
      autoApplicable: false,
      target: "process" as const,
    },
    {
      title: "Update deps",
      description: "Run npm audit fix",
      autoApplicable: true,
      target: "config" as const,
    },
  ],
  previousImprovementsChecked: true,
};

function makeMockClient() {
  return {
    createSession: vi
      .fn()
      .mockResolvedValue({ sessionId: "session-ret-1", availableModes: [], currentMode: "", availableModels: [], currentModel: "" }),
    sendPrompt: vi.fn().mockResolvedValue({
      response: "```json\n" + JSON.stringify(retroResponse) + "\n```",
      stopReason: "end_turn",
    }),
    endSession: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
  };
}

// --- Tests ---

describe("runSprintRetro", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns RetroResult with wentWell/wentBadly/improvements on happy path", async () => {
    const mockClient = makeMockClient();

    const result = await runSprintRetro(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockClient as any,
      makeConfig(),
      makeSprintResult(),
      makeReviewResult(),
    );

    expect(result.wentWell).toEqual(["Fast delivery", "Good test coverage"]);
    expect(result.wentBadly).toEqual(["Flaky CI"]);
    expect(result.improvements).toHaveLength(2);
    expect(result.previousImprovementsChecked).toBe(true);

    expect(mockClient.createSession).toHaveBeenCalledWith({
      cwd: "/tmp/test-project",
      mcpServers: [],
    });
    expect(mockClient.sendPrompt).toHaveBeenCalledTimes(2);
    expect(mockClient.endSession).toHaveBeenCalledWith("session-ret-1");
  });

  it("creates improvement issues for non-auto-applicable items", async () => {
    const mockClient = makeMockClient();

    await runSprintRetro(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockClient as any,
      makeConfig(),
      makeSprintResult(),
      makeReviewResult(),
    );

    // "Stabilize CI" (process, non-auto) → skipped (not auto-applicable)
    // "Update deps" (config, auto) → auto-applied via ACP
    // 2 sessions: retro + retro-apply for config improvement
    expect(mockClient.createSession).toHaveBeenCalledTimes(2);
    expect(mockClient.sendPrompt).toHaveBeenCalledTimes(2);
    const applyCall = mockClient.sendPrompt.mock.calls[1];
    expect(applyCall[1]).toContain("Update deps");
    expect(applyCall[1]).toContain(".aiscrum/config.yaml");
  });

  it("skips improvements with empty title", async () => {
    const mockClient = makeMockClient();
    mockClient.sendPrompt.mockResolvedValue({
      response: JSON.stringify({
        wentWell: [],
        wentBadly: [],
        improvements: [
          { title: "", description: "some desc", autoApplicable: true, target: "skill" },
          { title: "Valid", description: "valid desc", autoApplicable: true, target: "skill" },
        ],
        previousImprovementsChecked: false,
      }),
      stopReason: "end_turn",
    });

    await runSprintRetro(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockClient as any,
      makeConfig(),
      makeSprintResult(),
      makeReviewResult(),
    );

    // Only "Valid" should be auto-applied; empty title is skipped
    // 2 sessions: retro + retro-apply for "Valid"
    expect(mockClient.createSession).toHaveBeenCalledTimes(2);
    expect(mockClient.sendPrompt).toHaveBeenCalledTimes(2);
    const applyCall = mockClient.sendPrompt.mock.calls[1];
    expect(applyCall[1]).toContain("Valid");
  });

  it("handles missing previous retro file gracefully", async () => {
    const mockClient = makeMockClient();

    // fs.readFile for previous retro rejects by default in mock — should not throw
    const result = await runSprintRetro(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockClient as any,
      makeConfig(),
      makeSprintResult(),
      makeReviewResult(),
    );

    expect(result.wentWell).toBeDefined();
    expect(mockClient.sendPrompt).toHaveBeenCalled();
  });

  it("cleans up session on error", async () => {
    const mockClient = makeMockClient();
    mockClient.sendPrompt.mockRejectedValue(new Error("ACP failure"));

    await expect(
      runSprintRetro(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockClient as any,
        makeConfig(),
        makeSprintResult(),
        makeReviewResult(),
      ),
    ).rejects.toThrow("ACP failure");

    expect(mockClient.endSession).toHaveBeenCalledWith("session-ret-1");
  });

  it("emits session events when eventBus provided", async () => {
    const mockClient = makeMockClient();
    const eventBus = { emitTyped: vi.fn() };

    await runSprintRetro(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockClient as any,
      makeConfig(),
      makeSprintResult(),
      makeReviewResult(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eventBus as any,
    );

    expect(eventBus.emitTyped).toHaveBeenCalledWith("session:start", {
      sessionId: "session-ret-1",
      role: "retro",
    });
    expect(eventBus.emitTyped).toHaveBeenCalledWith("session:end", {
      sessionId: "session-ret-1",
    });
  });

  it("includes failure diagnostics in retro prompt", async () => {
    const mockClient = makeMockClient();
    await runSprintRetro(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockClient as any,
      makeConfig(),
      makeSprintResult(),
      makeReviewResult(),
    );

    const promptArg = mockClient.sendPrompt.mock.calls[0][1];
    expect(promptArg).toContain("tests-pass");
    expect(promptArg).toContain("3 tests failed");
  });

  it("auto-applies config improvement via ACP session", async () => {
    const configResponse = {
      wentWell: ["Good"],
      wentBadly: [],
      improvements: [
        {
          title: "Update deps",
          description: "Run npm audit fix",
          autoApplicable: true,
          target: "config" as const,
        },
      ],
      previousImprovementsChecked: true,
    };
    const mockClient = makeMockClient();
    mockClient.sendPrompt.mockResolvedValue({
      response: JSON.stringify(configResponse),
      stopReason: "end_turn",
    });

    await runSprintRetro(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockClient as any,
      makeConfig(),
      makeSprintResult(),
      makeReviewResult(),
    );

    // 2 sessions: retro + retro-apply
    expect(mockClient.createSession).toHaveBeenCalledTimes(2);
    expect(mockClient.sendPrompt).toHaveBeenCalledTimes(2);
    const applyCall = mockClient.sendPrompt.mock.calls[1];
    expect(applyCall[1]).toContain("Update deps");
    expect(applyCall[1]).toContain(".aiscrum/config.yaml");
  });

  it("creates backlog issue for process improvement instead of auto-applying", async () => {
    const { createIssue } = await import("../../src/github/issues.js");
    const processResponse = {
      wentWell: ["Good"],
      wentBadly: [],
      improvements: [
        {
          title: "Add retry logic",
          description: "Add retry for flaky CI steps",
          autoApplicable: true,
          target: "process" as const,
        },
      ],
      previousImprovementsChecked: true,
    };
    const mockClient = makeMockClient();
    mockClient.sendPrompt.mockResolvedValue({
      response: JSON.stringify(processResponse),
      stopReason: "end_turn",
    });

    await runSprintRetro(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockClient as any,
      makeConfig(),
      makeSprintResult(),
      makeReviewResult(),
    );

    // Only 1 session (retro) — no ACP apply session for process target
    expect(mockClient.createSession).toHaveBeenCalledTimes(1);
    expect(mockClient.sendPrompt).toHaveBeenCalledTimes(1);
    // Instead, a GitHub issue should be created
    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "[Retro] Add retry logic",
        labels: ["human-decision-needed", "type:improvement"],
      }),
    );
  });

  it("skips non-auto-applicable improvement with warning", async () => {
    const response = {
      wentWell: ["Good"],
      wentBadly: [],
      improvements: [
        {
          title: "Manual change needed",
          description: "Requires stakeholder input",
          autoApplicable: false,
          target: "process" as const,
        },
      ],
      previousImprovementsChecked: true,
    };
    const mockClient = makeMockClient();
    mockClient.sendPrompt.mockResolvedValue({
      response: JSON.stringify(response),
      stopReason: "end_turn",
    });

    await runSprintRetro(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockClient as any,
      makeConfig(),
      makeSprintResult(),
      makeReviewResult(),
    );

    // Only 1 session (retro), no retro-apply session
    expect(mockClient.createSession).toHaveBeenCalledTimes(1);
    expect(mockClient.sendPrompt).toHaveBeenCalledTimes(1);

    // Logger warn should have been called for non-auto-applicable
    const childLogger = (logger as unknown as { child: () => { warn: ReturnType<typeof vi.fn> } }).child();
    expect(childLogger.warn).toHaveBeenCalledWith(
      { title: "Manual change needed", target: "process" },
      "Skipping non-auto-applicable improvement",
    );
  });

  it("auto-applies skill improvements via ACP session", async () => {
    const skillResponse = {
      wentWell: ["Good"],
      wentBadly: [],
      improvements: [
        {
          title: "Improve planner prompt",
          description: "Add acceptance criteria reminder to planner prompt",
          autoApplicable: true,
          target: "skill" as const,
        },
      ],
      previousImprovementsChecked: true,
    };
    const mockClient = makeMockClient();
    mockClient.sendPrompt.mockResolvedValue({
      response: JSON.stringify(skillResponse),
      stopReason: "end_turn",
    });

    await runSprintRetro(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockClient as any,
      makeConfig(),
      makeSprintResult(),
      makeReviewResult(),
    );

    // 2 sessions: retro + retro-apply
    expect(mockClient.createSession).toHaveBeenCalledTimes(2);

    // 2 sendPrompt: retro analysis + skill improvement application
    expect(mockClient.sendPrompt).toHaveBeenCalledTimes(2);
    const applyCall = mockClient.sendPrompt.mock.calls[1];
    expect(applyCall[1]).toContain("Improve planner prompt");
    expect(applyCall[1]).toContain(".aiscrum/roles/");

    // No issues created for auto-applied skill improvements
  });
});
