import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SprintConfig, IssueResult, QualityResult } from "../../src/types.js";

// --- Mocks ---

vi.mock("../../src/git/merge.js", () => ({
  mergeBranch: vi.fn(),
}));

vi.mock("../../src/git/worktree.js", () => ({
  deleteBranch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/acp/session-config.js", () => ({
  resolveSessionConfig: vi.fn().mockResolvedValue({
    mcpServers: [],
    instructions: "",
    model: undefined,
  }),
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
  return { logger: childLogger, appendErrorLog: noop };
});

const { mergeBranch } = await import("../../src/git/merge.js");
const { deleteBranch } = await import("../../src/git/worktree.js");

const { mergeCompletedBranches, resolveConflictsViaAcp } = await import(
  "../../src/ceremonies/merge-pipeline.js"
);

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
    maxRetries: 2,
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

const passingQuality: QualityResult = {
  passed: true,
  checks: [
    { name: "tests-pass", passed: true, detail: "Tests passed", category: "test" },
  ],
};

function makeResult(overrides: Partial<IssueResult> = {}): IssueResult {
  return {
    issueNumber: 42,
    status: "completed",
    qualityGatePassed: true,
    qualityDetails: passingQuality,
    branch: "sprint/3/issue-42",
    duration_ms: 5000,
    filesChanged: ["src/foo.ts"],
    retryCount: 0,
    points: 3,
    ...overrides,
  };
}

function makeMockClient() {
  return {
    createSession: vi.fn().mockResolvedValue({
      sessionId: "session-abc",
      availableModes: [],
      currentMode: "",
      availableModels: [],
      currentModel: "",
    }),
    sendPrompt: vi.fn().mockResolvedValue({
      response: "Conflicts resolved successfully",
      stopReason: "end_turn",
    }),
    endSession: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
  };
}

// --- mergeCompletedBranches ---

describe("mergeCompletedBranches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters results to only quality-passed completed issues", async () => {
    vi.mocked(mergeBranch).mockResolvedValue({ success: true });

    const results = [
      makeResult({ issueNumber: 1, status: "completed", qualityGatePassed: true }),
      makeResult({ issueNumber: 2, status: "failed", qualityGatePassed: false }),
      makeResult({ issueNumber: 3, status: "completed", qualityGatePassed: false }),
      makeResult({ issueNumber: 4, status: "in-progress", qualityGatePassed: true }),
    ];

    const outcome = await mergeCompletedBranches(makeConfig(), results, "main");

    expect(mergeBranch).toHaveBeenCalledTimes(1);
    expect(outcome.merged).toEqual([1]);
    expect(outcome.conflicted).toEqual([]);
  });

  it("merges eligible branches with squash option from config", async () => {
    vi.mocked(mergeBranch).mockResolvedValue({ success: true });

    const results = [makeResult({ issueNumber: 10, branch: "sprint/3/issue-10" })];
    await mergeCompletedBranches(makeConfig({ squashMerge: true }), results, "main");

    expect(mergeBranch).toHaveBeenCalledWith("sprint/3/issue-10", "main", {
      squash: true,
    });
  });

  it("handles merge conflicts and records conflict files", async () => {
    vi.mocked(mergeBranch).mockResolvedValue({
      success: false,
      conflictFiles: ["src/api.ts", "src/index.ts"],
    });

    const results = [makeResult({ issueNumber: 7, branch: "sprint/3/issue-7" })];
    const outcome = await mergeCompletedBranches(makeConfig(), results, "main");

    expect(outcome.merged).toEqual([]);
    expect(outcome.conflicted).toEqual([7]);
    expect(outcome.conflictDetails.get(7)).toEqual(["src/api.ts", "src/index.ts"]);
  });

  it("deletes branch after successful merge when config enabled", async () => {
    vi.mocked(mergeBranch).mockResolvedValue({ success: true });

    const results = [makeResult({ issueNumber: 5, branch: "sprint/3/issue-5" })];
    await mergeCompletedBranches(
      makeConfig({ deleteBranchAfterMerge: true }),
      results,
      "main",
    );

    expect(deleteBranch).toHaveBeenCalledWith("sprint/3/issue-5");
  });

  it("does not delete branch when config disabled", async () => {
    vi.mocked(mergeBranch).mockResolvedValue({ success: true });

    const results = [makeResult({ issueNumber: 5, branch: "sprint/3/issue-5" })];
    await mergeCompletedBranches(
      makeConfig({ deleteBranchAfterMerge: false }),
      results,
      "main",
    );

    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it("continues merging remaining issues when one has a conflict", async () => {
    vi.mocked(mergeBranch)
      .mockResolvedValueOnce({ success: false, conflictFiles: ["a.ts"] })
      .mockResolvedValueOnce({ success: true });

    const results = [
      makeResult({ issueNumber: 1, branch: "sprint/3/issue-1" }),
      makeResult({ issueNumber: 2, branch: "sprint/3/issue-2" }),
    ];
    const outcome = await mergeCompletedBranches(makeConfig(), results, "main");

    expect(outcome.conflicted).toEqual([1]);
    expect(outcome.merged).toEqual([2]);
  });

  it("handles unexpected merge error by marking as conflicted", async () => {
    vi.mocked(mergeBranch).mockRejectedValue(new Error("git crash"));

    const results = [makeResult({ issueNumber: 9 })];
    const outcome = await mergeCompletedBranches(makeConfig(), results, "main");

    expect(outcome.conflicted).toEqual([9]);
    expect(outcome.merged).toEqual([]);
  });

  it("handles branch deletion failure gracefully", async () => {
    vi.mocked(mergeBranch).mockResolvedValue({ success: true });
    vi.mocked(deleteBranch).mockRejectedValue(new Error("delete failed"));

    const results = [makeResult({ issueNumber: 6, branch: "sprint/3/issue-6" })];
    const outcome = await mergeCompletedBranches(
      makeConfig({ deleteBranchAfterMerge: true }),
      results,
      "main",
    );

    // Merge still counted as success despite branch deletion failure
    expect(outcome.merged).toEqual([6]);
    expect(outcome.conflicted).toEqual([]);
  });

  it("returns empty results when no issues are eligible", async () => {
    const results = [
      makeResult({ issueNumber: 1, status: "failed", qualityGatePassed: false }),
    ];
    const outcome = await mergeCompletedBranches(makeConfig(), results, "main");

    expect(mergeBranch).not.toHaveBeenCalled();
    expect(outcome.merged).toEqual([]);
    expect(outcome.conflicted).toEqual([]);
  });
});

// --- resolveConflictsViaAcp ---

describe("resolveConflictsViaAcp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when ACP resolves conflicts successfully", async () => {
    const client = makeMockClient();

    const result = await resolveConflictsViaAcp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      makeConfig(),
      "feat/branch",
      "main",
      ["src/a.ts"],
    );

    expect(result).toBe(true);
    expect(client.createSession).toHaveBeenCalled();
    expect(client.sendPrompt).toHaveBeenCalledWith(
      "session-abc",
      expect.stringContaining("feat/branch"),
    );
    expect(client.endSession).toHaveBeenCalledWith("session-abc");
  });

  it("returns false when ACP response indicates inability to resolve", async () => {
    const client = makeMockClient();
    client.sendPrompt.mockResolvedValue({
      response: "I was unable to resolve the conflicts",
      stopReason: "end_turn",
    });

    const result = await resolveConflictsViaAcp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      makeConfig(),
      "feat/branch",
      "main",
      ["src/a.ts"],
    );

    expect(result).toBe(false);
  });

  it("returns false when ACP session throws an error", async () => {
    const client = makeMockClient();
    client.createSession.mockRejectedValue(new Error("connection failed"));

    const result = await resolveConflictsViaAcp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      makeConfig(),
      "feat/branch",
      "main",
      ["src/a.ts"],
    );

    expect(result).toBe(false);
  });
});
