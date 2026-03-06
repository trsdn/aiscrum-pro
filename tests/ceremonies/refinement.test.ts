import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SprintConfig } from "../../src/types.js";

// --- Mocks ---

vi.mock("../../src/acp/session-config.js", () => ({
  applySessionSettings: vi.fn(),
  resolveSessionConfig: vi.fn().mockResolvedValue({
    mcpServers: [],
    instructions: "",
    model: undefined,
  }),
}));

vi.mock("../../src/github/issues.js", () => ({
  listIssues: vi.fn(),
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
      .mockResolvedValue("Refinement for sprint {{SPRINT_NUMBER}} project {{PROJECT_NAME}}"),
  },
}));

const { listIssues } = await import("../../src/github/issues.js");
const { resolveSessionConfig } = await import("../../src/acp/session-config.js");
const { runRefinement } = await import("../../src/ceremonies/refinement.js");

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

const refinementResponse = {
  refined_issues: [
    { number: 10, title: "feat(api): search", ice_score: 300 },
    { number: 12, title: "fix(auth): token refresh", ice_score: 400 },
  ],
};

function makeMockClient() {
  return {
    createSession: vi.fn().mockResolvedValue({
      sessionId: "session-ref-1",
      availableModes: [],
      currentMode: "",
      availableModels: [],
      currentModel: "",
    }),
    sendPrompt: vi.fn().mockResolvedValue({
      response: "```json\n" + JSON.stringify(refinementResponse) + "\n```",
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

describe("runRefinement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listIssues).mockResolvedValue([
      { number: 10, title: "feat(api): search", labels: ["type:idea"] },
      { number: 12, title: "fix(auth): token refresh", labels: ["type:idea"] },
    ]);
  });

  it("returns parsed RefinedIssue array on happy path", async () => {
    const mockClient = makeMockClient();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runRefinement(mockClient as any, makeConfig());

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ number: 10, title: "feat(api): search", ice_score: 300 });
    expect(result[1]).toEqual({ number: 12, title: "fix(auth): token refresh", ice_score: 400 });

    expect(mockClient.createSession).toHaveBeenCalledWith({
      cwd: "/tmp/test-project",
      mcpServers: [],
    });
    expect(mockClient.sendPrompt).toHaveBeenCalledOnce();
    expect(mockClient.endSession).toHaveBeenCalledWith("session-ref-1");
  });

  it("handles malformed ACP JSON response gracefully", async () => {
    const mockClient = makeMockClient();
    mockClient.sendPrompt.mockResolvedValue({
      response: "no json here at all",
      stopReason: "end_turn",
    });

    // extractJson throws when no JSON found
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(runRefinement(mockClient as any, makeConfig())).rejects.toThrow();
    // Session should still be cleaned up
    expect(mockClient.endSession).toHaveBeenCalledWith("session-ref-1");
  });

  it("calls endSession in finally block even on error", async () => {
    const mockClient = makeMockClient();
    mockClient.sendPrompt.mockRejectedValue(new Error("session timeout"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(runRefinement(mockClient as any, makeConfig())).rejects.toThrow("session timeout");

    expect(mockClient.endSession).toHaveBeenCalledWith("session-ref-1");
  });

  it("emits session:start and session:end events when eventBus provided", async () => {
    const mockClient = makeMockClient();
    const eventBus = { emitTyped: vi.fn() };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runRefinement(mockClient as any, makeConfig(), eventBus as any);

    expect(eventBus.emitTyped).toHaveBeenCalledWith("session:start", {
      sessionId: "session-ref-1",
      role: "refinement",
    });
    expect(eventBus.emitTyped).toHaveBeenCalledWith("session:end", {
      sessionId: "session-ref-1",
    });
  });

  it("applies session settings when model is configured", async () => {
    const mockClient = makeMockClient();
    vi.mocked(resolveSessionConfig).mockResolvedValue({
      mcpServers: [],
      instructions: "custom instructions",
      model: "claude-sonnet-4",
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runRefinement(mockClient as any, makeConfig());

    const { applySessionSettings } = await import("../../src/acp/session-config.js");
    expect(applySessionSettings).toHaveBeenCalledWith(mockClient, "session-ref-1", {
      mcpServers: [],
      instructions: "custom instructions",
      model: "claude-sonnet-4",
    });
  });

  it("returns empty array when no idea issues exist", async () => {
    const mockClient = makeMockClient();
    vi.mocked(listIssues).mockResolvedValue([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runRefinement(mockClient as any, makeConfig());

    expect(result).toEqual([]);
    // Should not create any ACP session
    expect(mockClient.createSession).not.toHaveBeenCalled();
  });
});
