import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SprintConfig, SprintResult } from "../../src/types.js";

// --- Mocks ---

vi.mock("../../src/acp/session-config.js", () => ({
  applySessionSettings: vi.fn(),
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
  topFailedGates: vi.fn().mockReturnValue("none"),
}));

vi.mock("../../src/documentation/velocity.js", () => ({
  readVelocity: vi.fn().mockReturnValue([]),
}));

vi.mock("../../src/logger.js", () => {
  const noop = () => {};
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
    readFile: vi
      .fn()
      .mockResolvedValue(
        "Review for sprint {{SPRINT_NUMBER}} project {{PROJECT_NAME}} flagged:{{FLAGGED_PRS}}",
      ),
  },
}));

vi.mock("../../src/git/merge.js", () => ({
  getPRStatus: vi.fn(),
}));

const { resolveSessionConfig } = await import("../../src/acp/session-config.js");
const { runSprintReview } = await import("../../src/ceremonies/review.js");

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
        filesChanged: ["src/api.ts"],
        retryCount: 0,
      },
    ],
    parallelizationRatio: 1.0,
    avgWorktreeLifetime: 120,
    mergeConflicts: 0,
    ...overrides,
  };
}

const reviewResponse = {
  summary: "Sprint 3 delivered search endpoint",
  demoItems: ["Search API endpoint"],
  velocityUpdate: "On track",
  openItems: ["Auth edge case"],
};

function makeMockClient() {
  return {
    createSession: vi.fn().mockResolvedValue({
      sessionId: "session-rev-1",
      availableModes: [],
      currentMode: "",
      availableModels: [],
      currentModel: "",
    }),
    sendPrompt: vi.fn().mockResolvedValue({
      response: "```json\n" + JSON.stringify(reviewResponse) + "\n```",
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

describe("runSprintReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ReviewResult with defaults filled on happy path", async () => {
    const mockClient = makeMockClient();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runSprintReview(mockClient as any, makeConfig(), makeSprintResult());

    expect(result.summary).toBe("Sprint 3 delivered search endpoint");
    expect(result.demoItems).toEqual(["Search API endpoint"]);
    expect(result.velocityUpdate).toBe("On track");
    expect(result.openItems).toEqual(["Auth edge case"]);

    expect(mockClient.createSession).toHaveBeenCalledWith({
      cwd: "/tmp/test-project",
      mcpServers: [],
    });
    expect(mockClient.sendPrompt).toHaveBeenCalledOnce();
    expect(mockClient.endSession).toHaveBeenCalledWith("session-rev-1");
  });

  it("handles missing arrays by defaulting to empty", async () => {
    const mockClient = makeMockClient();
    mockClient.sendPrompt.mockResolvedValue({
      response: JSON.stringify({ summary: "Short review", velocityUpdate: "ok" }),
      stopReason: "end_turn",
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runSprintReview(mockClient as any, makeConfig(), makeSprintResult());

    expect(result.demoItems).toEqual([]);
    expect(result.openItems).toEqual([]);
  });

  it("creates session with correct config from resolveSessionConfig", async () => {
    const mockClient = makeMockClient();
    vi.mocked(resolveSessionConfig).mockResolvedValue({
      mcpServers: [{ name: "test-server", command: "test" }],
      instructions: "review instructions",
      model: "gpt-4",
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runSprintReview(mockClient as any, makeConfig(), makeSprintResult());

    expect(mockClient.createSession).toHaveBeenCalledWith({
      cwd: "/tmp/test-project",
      mcpServers: [{ name: "test-server", command: "test" }],
    });
    const { applySessionSettings } = await import("../../src/acp/session-config.js");
    expect(applySessionSettings).toHaveBeenCalledWith(mockClient, "session-rev-1", {
      mcpServers: [{ name: "test-server", command: "test" }],
      instructions: "review instructions",
      model: "gpt-4",
    });
  });

  it("cleans up session on error", async () => {
    const mockClient = makeMockClient();
    mockClient.sendPrompt.mockRejectedValue(new Error("ACP timeout"));

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runSprintReview(mockClient as any, makeConfig(), makeSprintResult()),
    ).rejects.toThrow("ACP timeout");

    expect(mockClient.endSession).toHaveBeenCalledWith("session-rev-1");
  });

  it("emits session events when eventBus provided", async () => {
    const mockClient = makeMockClient();
    const eventBus = { emitTyped: vi.fn() };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runSprintReview(mockClient as any, makeConfig(), makeSprintResult(), eventBus as any);

    expect(eventBus.emitTyped).toHaveBeenCalledWith("session:start", {
      sessionId: "session-rev-1",
      role: "review",
    });
    expect(eventBus.emitTyped).toHaveBeenCalledWith("session:end", {
      sessionId: "session-rev-1",
    });
  });

  it("flags closed-without-merge PRs in review prompt", async () => {
    const mockClient = makeMockClient();
    const { getPRStatus } = await import("../../src/git/merge.js");

    vi.mocked(getPRStatus).mockResolvedValueOnce({ prNumber: 123, state: "CLOSED" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runSprintReview(mockClient as any, makeConfig(), makeSprintResult());

    expect(getPRStatus).toHaveBeenCalledWith("sprint/3/issue-10");
    // Flagged PRs are included in the prompt sent to ACP
    const sentPrompt = mockClient.sendPrompt.mock.calls[0]?.[1] as string;
    expect(sentPrompt).toContain("closed without merge");
  });

  it("passes review when all PRs are merged", async () => {
    const mockClient = makeMockClient();
    const { getPRStatus } = await import("../../src/git/merge.js");

    vi.mocked(getPRStatus).mockResolvedValueOnce({ prNumber: 456, state: "MERGED" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runSprintReview(mockClient as any, makeConfig(), makeSprintResult());

    expect(getPRStatus).toHaveBeenCalledWith("sprint/3/issue-10");
    // No flagged PRs means "none" in the prompt
    const sentPrompt = mockClient.sendPrompt.mock.calls[0]?.[1] as string;
    expect(sentPrompt).not.toContain("closed without merge");
  });

  it("handles missing PRs gracefully", async () => {
    const mockClient = makeMockClient();
    const { getPRStatus } = await import("../../src/git/merge.js");

    vi.mocked(getPRStatus).mockResolvedValueOnce(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runSprintReview(mockClient as any, makeConfig(), makeSprintResult());

    expect(getPRStatus).toHaveBeenCalledWith("sprint/3/issue-10");
    // Missing PR is flagged in the prompt
    const sentPrompt = mockClient.sendPrompt.mock.calls[0]?.[1] as string;
    expect(sentPrompt).toContain("no PR found");
  });
});
