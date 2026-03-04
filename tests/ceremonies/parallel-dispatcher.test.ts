import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SprintConfig, SprintPlan, SprintIssue, IssueResult } from "../../src/types.js";

// --- Mocks ---

vi.mock("../../src/ceremonies/dep-graph.js", () => ({
  buildExecutionGroups: vi.fn(),
}));

vi.mock("../../src/ceremonies/execution.js", () => ({
  executeIssue: vi.fn(),
}));

vi.mock("../../src/git/merge.js", () => ({
  mergeIssuePR: vi.fn(),
  hasConflicts: vi.fn(),
}));

vi.mock("../../src/git/worktree.js", () => ({
  createWorktree: vi.fn().mockResolvedValue(undefined),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/ceremonies/quality-retry.js", () => ({
  buildQualityGateConfig: vi.fn().mockReturnValue({
    testCommand: ["npm", "test"],
    typecheckCommand: ["npx", "tsc", "--noEmit"],
    lintCommand: ["npx", "eslint"],
    buildCommand: ["npm", "run", "build"],
    requireTests: true,
    requireLint: true,
    requireTypes: true,
    requireBuild: false,
    maxDiffLines: 500,
  }),
}));

const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", async () => {
  const actual = await vi.importActual<typeof import("node:util")>("node:util");
  return {
    ...actual,
    promisify: vi.fn().mockReturnValue(mockExecFileAsync),
  };
});

vi.mock("../../src/github/labels.js", () => ({
  setLabel: vi.fn().mockResolvedValue(undefined),
  setStatusLabel: vi.fn().mockResolvedValue(undefined),
  getLabels: vi.fn().mockResolvedValue([]),
  removeLabel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/github/issues.js", () => ({
  addComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/enforcement/escalation.js", () => ({
  escalateToStakeholder: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/enforcement/quality-gate.js", () => ({
  verifyMainBranch: vi.fn().mockResolvedValue({ passed: true, checks: [] }),
}));

vi.mock("../../src/logger.js", () => {
  const noop = () => {};
  const child = () => ({
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child,
  });
  return {
    logger: { child },
    appendErrorLog: noop,
  };
});

import { runParallelExecution } from "../../src/ceremonies/parallel-dispatcher.js";
import { buildExecutionGroups } from "../../src/ceremonies/dep-graph.js";
import { executeIssue } from "../../src/ceremonies/execution.js";
import { hasConflicts, mergeIssuePR } from "../../src/git/merge.js";
import { createWorktree, removeWorktree } from "../../src/git/worktree.js";
import { setStatusLabel } from "../../src/github/labels.js";
import { addComment } from "../../src/github/issues.js";
import { escalateToStakeholder } from "../../src/enforcement/escalation.js";

// --- Helpers ---

function makeIssue(n: number, deps: number[] = []): SprintIssue {
  return {
    number: n,
    title: `Issue ${n}`,
    ice_score: 10,
    depends_on: deps,
    acceptanceCriteria: "AC",
    expectedFiles: [],
    points: 1,
  };
}

function makeResult(n: number, status: "completed" | "failed" = "completed"): IssueResult {
  return {
    issueNumber: n,
    status,
    qualityGatePassed: status === "completed",
    qualityDetails: { passed: status === "completed", checks: [] },
    branch: `sprint/1/issue-${n}`,
    duration_ms: 1000,
    filesChanged: ["src/a.ts"],
    retryCount: 0,
    points: 1,
  };
}

function makeConfig(overrides: Partial<SprintConfig> = {}): SprintConfig {
  return {
    sprintNumber: 1,
    sprintPrefix: "Sprint",
    sprintSlug: "sprint",
    projectPath: "/project",
    baseBranch: "main",
    worktreeBase: "/tmp/wt",
    branchPattern: "{prefix}/{sprint}/issue-{issue}",
    maxParallelSessions: 3,
    maxIssuesPerSprint: 10,
    maxDriftIncidents: 2,
    maxRetries: 1,
    enableChallenger: false,
    sequentialExecution: false,
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

function makePlan(issues: SprintIssue[]): SprintPlan {
  return {
    sprintNumber: 1,
    sprint_issues: issues,
    execution_groups: [],
    estimated_points: issues.reduce((s, i) => s + i.points, 0),
    rationale: "test",
  };
}

const mockClient = {
  connect: vi.fn(),
  createSession: vi.fn(),
  sendPrompt: vi.fn(),
  endSession: vi.fn(),
  disconnect: vi.fn(),
  connected: true,
} as unknown as import("../../src/acp/client.js").AcpClient;

// --- Tests ---

describe("runParallelExecution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no conflicts, pre-merge verification passes
    vi.mocked(hasConflicts).mockResolvedValue(false);
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
  });

  it("executes a single group of parallel issues", async () => {
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
    vi.mocked(buildExecutionGroups).mockReturnValue([{ group: 0, issues: [1, 2, 3] }]);
    vi.mocked(executeIssue)
      .mockResolvedValueOnce(makeResult(1))
      .mockResolvedValueOnce(makeResult(2))
      .mockResolvedValueOnce(makeResult(3));
    vi.mocked(mergeIssuePR).mockResolvedValue({ success: true });

    const result = await runParallelExecution(mockClient, makeConfig(), makePlan(issues));

    expect(result.results).toHaveLength(3);
    expect(result.sprint).toBe(1);
    expect(result.parallelizationRatio).toBe(3);
    expect(result.mergeConflicts).toBe(0);
    expect(executeIssue).toHaveBeenCalledTimes(3);
    expect(mergeIssuePR).toHaveBeenCalledTimes(3);
  });

  it("executes multiple sequential groups in order", async () => {
    const issues = [makeIssue(1), makeIssue(2, [1]), makeIssue(3, [1])];
    vi.mocked(buildExecutionGroups).mockReturnValue([
      { group: 0, issues: [1] },
      { group: 1, issues: [2, 3] },
    ]);

    const callOrder: number[] = [];
    vi.mocked(executeIssue).mockImplementation(async (_c, _cfg, issue) => {
      callOrder.push(issue.number);
      return makeResult(issue.number);
    });
    vi.mocked(mergeIssuePR).mockResolvedValue({ success: true });

    const result = await runParallelExecution(mockClient, makeConfig(), makePlan(issues));

    expect(result.results).toHaveLength(3);
    // Issue 1 must execute before issues 2 & 3
    expect(callOrder.indexOf(1)).toBeLessThan(callOrder.indexOf(2));
    expect(callOrder.indexOf(1)).toBeLessThan(callOrder.indexOf(3));
    expect(result.parallelizationRatio).toBe(1.5); // 3 issues / 2 groups
  });

  it("handles merge conflicts by marking issue as failed", async () => {
    const issues = [makeIssue(1), makeIssue(2)];
    vi.mocked(buildExecutionGroups).mockReturnValue([{ group: 0, issues: [1, 2] }]);
    vi.mocked(executeIssue)
      .mockResolvedValueOnce(makeResult(1))
      .mockResolvedValueOnce(makeResult(2));
    vi.mocked(mergeIssuePR)
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, reason: "merge conflict" });

    const result = await runParallelExecution(mockClient, makeConfig(), makePlan(issues));

    expect(result.mergeConflicts).toBe(1);
    const failedResult = result.results.find((r) => r.issueNumber === 2);
    expect(failedResult?.status).toBe("failed");
    expect(failedResult?.qualityGatePassed).toBe(false);
    expect(setStatusLabel).toHaveBeenCalledWith(2, "status:blocked");
  });

  it("skips merging when autoMerge is disabled", async () => {
    const issues = [makeIssue(1)];
    vi.mocked(buildExecutionGroups).mockReturnValue([{ group: 0, issues: [1] }]);
    vi.mocked(executeIssue).mockResolvedValueOnce(makeResult(1));

    const result = await runParallelExecution(
      mockClient,
      makeConfig({ autoMerge: false }),
      makePlan(issues),
    );

    expect(result.results).toHaveLength(1);
    expect(mergeIssuePR).not.toHaveBeenCalled();
    expect(result.mergeConflicts).toBe(0);
  });

  it("respects concurrency limit via p-limit", async () => {
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4)];
    vi.mocked(buildExecutionGroups).mockReturnValue([{ group: 0, issues: [1, 2, 3, 4] }]);

    let concurrent = 0;
    let maxConcurrent = 0;

    vi.mocked(executeIssue).mockImplementation(async (_c, _cfg, issue) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 50));
      concurrent--;
      return makeResult(issue.number);
    });
    vi.mocked(mergeIssuePR).mockResolvedValue({ success: true });

    await runParallelExecution(
      mockClient,
      makeConfig({ maxParallelSessions: 2 }),
      makePlan(issues),
    );

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(executeIssue).toHaveBeenCalledTimes(4);
  });

  it("pauses execution when all issues in a group fail", async () => {
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3, [1, 2])];
    vi.mocked(buildExecutionGroups).mockReturnValue([
      { group: 0, issues: [1, 2] },
      { group: 1, issues: [3] },
    ]);
    vi.mocked(executeIssue)
      .mockResolvedValueOnce(makeResult(1, "failed"))
      .mockResolvedValueOnce(makeResult(2, "failed"));

    const result = await runParallelExecution(
      mockClient,
      makeConfig({ autoMerge: false }),
      makePlan(issues),
    );

    // Group 1 should never execute because group 0 had all failures
    expect(result.results).toHaveLength(2);
    expect(executeIssue).toHaveBeenCalledTimes(2);
  });

  it("escalates to stakeholder when all issues in group fail", async () => {
    const { SprintEventBus } = await import("../../src/events.js");
    const eventBus = new SprintEventBus();
    const emitSpy = vi.spyOn(eventBus, "emitTyped");

    const issues = [makeIssue(1), makeIssue(2), makeIssue(3, [1, 2])];
    vi.mocked(buildExecutionGroups).mockReturnValue([
      { group: 0, issues: [1, 2] },
      { group: 1, issues: [3] },
    ]);
    vi.mocked(executeIssue)
      .mockResolvedValueOnce(makeResult(1, "failed"))
      .mockResolvedValueOnce(makeResult(2, "failed"));

    await runParallelExecution(
      mockClient,
      makeConfig({ autoMerge: false }),
      makePlan(issues),
      eventBus,
    );

    expect(escalateToStakeholder).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "must",
        reason: expect.stringContaining("All issues"),
        detail: expect.stringContaining("#1"),
      }),
      expect.any(Object),
      eventBus,
    );

    expect(emitSpy).toHaveBeenCalledWith(
      "sprint:error",
      expect.objectContaining({
        error: expect.stringContaining("group 0 failed"),
      }),
    );
  });

  it("computes avgWorktreeLifetime from durations", async () => {
    const issues = [makeIssue(1), makeIssue(2)];
    vi.mocked(buildExecutionGroups).mockReturnValue([{ group: 0, issues: [1, 2] }]);
    vi.mocked(executeIssue)
      .mockResolvedValueOnce({ ...makeResult(1), duration_ms: 2000 })
      .mockResolvedValueOnce({ ...makeResult(2), duration_ms: 4000 });
    vi.mocked(mergeIssuePR).mockResolvedValue({ success: true });

    const result = await runParallelExecution(mockClient, makeConfig(), makePlan(issues));

    expect(result.avgWorktreeLifetime).toBe(3000);
  });

  it("tracks rejected executeIssue as failed IssueResult", async () => {
    const issues = [makeIssue(1), makeIssue(2)];
    vi.mocked(buildExecutionGroups).mockReturnValue([{ group: 0, issues: [1, 2] }]);
    vi.mocked(executeIssue)
      .mockResolvedValueOnce(makeResult(1))
      .mockRejectedValueOnce(new Error("session crashed"));
    vi.mocked(mergeIssuePR).mockResolvedValue({ success: true });

    const result = await runParallelExecution(mockClient, makeConfig(), makePlan(issues));

    expect(result.results).toHaveLength(2);
    const rejected = result.results.find((r) => r.issueNumber === 2)!;
    expect(rejected.status).toBe("failed");
    expect(rejected.qualityGatePassed).toBe(false);
    expect(rejected.retryCount).toBe(0);
    expect(rejected.duration_ms).toBe(0);
    expect(rejected.branch).toBe("sprint/1/issue-2");
  });

  it("counts fulfilled-failed and rejected correctly in mixed results", async () => {
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
    vi.mocked(buildExecutionGroups).mockReturnValue([{ group: 0, issues: [1, 2, 3] }]);
    vi.mocked(executeIssue)
      .mockResolvedValueOnce(makeResult(1)) // fulfilled, completed
      .mockResolvedValueOnce(makeResult(2, "failed")) // fulfilled, failed
      .mockRejectedValueOnce(new Error("timeout")); // rejected
    vi.mocked(mergeIssuePR).mockResolvedValue({ success: true });

    const result = await runParallelExecution(mockClient, makeConfig(), makePlan(issues));

    expect(result.results).toHaveLength(3);
    const completed = result.results.filter((r) => r.status === "completed");
    const failed = result.results.filter((r) => r.status === "failed");
    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(2);
    expect(failed.map((r) => r.issueNumber).sort()).toEqual([2, 3]);
  });

  it("returns empty results for plan with no issues", async () => {
    vi.mocked(buildExecutionGroups).mockReturnValue([]);

    const result = await runParallelExecution(mockClient, makeConfig(), makePlan([]));

    expect(result.results).toHaveLength(0);
    expect(result.parallelizationRatio).toBe(1);
    expect(result.avgWorktreeLifetime).toBe(0);
    expect(result.mergeConflicts).toBe(0);
  });

  // --- Pre-merge verification tests ---

  it("runs pre-merge verification before mergeIssuePR", async () => {
    const issues = [makeIssue(1)];
    vi.mocked(buildExecutionGroups).mockReturnValue([{ group: 0, issues: [1] }]);
    vi.mocked(executeIssue).mockResolvedValueOnce(makeResult(1));
    vi.mocked(mergeIssuePR).mockResolvedValue({ success: true });

    await runParallelExecution(mockClient, makeConfig(), makePlan(issues));

    // hasConflicts should be called before mergeIssuePR
    expect(hasConflicts).toHaveBeenCalledWith("sprint/1/issue-1", "main");
    expect(createWorktree).toHaveBeenCalled();
    expect(mergeIssuePR).toHaveBeenCalledTimes(1);
  });

  it("blocks issue and skips merge when pre-merge verification detects conflicts", async () => {
    const issues = [makeIssue(1)];
    vi.mocked(buildExecutionGroups).mockReturnValue([{ group: 0, issues: [1] }]);
    vi.mocked(executeIssue).mockResolvedValueOnce(makeResult(1));
    vi.mocked(hasConflicts).mockResolvedValue(true);

    const result = await runParallelExecution(mockClient, makeConfig(), makePlan(issues));

    expect(mergeIssuePR).not.toHaveBeenCalled();
    const issue1 = result.results.find((r) => r.issueNumber === 1)!;
    expect(issue1.status).toBe("failed");
    expect(issue1.qualityGatePassed).toBe(false);
    expect(setStatusLabel).toHaveBeenCalledWith(1, "status:blocked");
    expect(addComment).toHaveBeenCalledWith(1, expect.stringContaining("Merge conflicts"));
  });

  it("blocks issue when tests fail in pre-merge verification", async () => {
    const issues = [makeIssue(1)];
    vi.mocked(buildExecutionGroups).mockReturnValue([{ group: 0, issues: [1] }]);
    vi.mocked(executeIssue).mockResolvedValueOnce(makeResult(1));
    // execFile: rebase calls (fetch, rebase, push) then pre-merge (fetch, merge, npm test fails)
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // rebase: git fetch
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // rebase: git rebase
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // rebase: git push
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // pre-merge: git fetch
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // pre-merge: git merge
      .mockRejectedValueOnce(new Error("test failure")); // pre-merge: npm test

    const result = await runParallelExecution(mockClient, makeConfig(), makePlan(issues));

    expect(mergeIssuePR).not.toHaveBeenCalled();
    const issue1 = result.results.find((r) => r.issueNumber === 1)!;
    expect(issue1.status).toBe("failed");
    expect(issue1.qualityGatePassed).toBe(false);
    expect(setStatusLabel).toHaveBeenCalledWith(1, "status:blocked");
    expect(addComment).toHaveBeenCalledWith(1, expect.stringContaining("Tests failed"));
  });

  it("blocks issue when type check fails in pre-merge verification", async () => {
    const issues = [makeIssue(1)];
    vi.mocked(buildExecutionGroups).mockReturnValue([{ group: 0, issues: [1] }]);
    vi.mocked(executeIssue).mockResolvedValueOnce(makeResult(1));
    // execFile: rebase calls (fetch, rebase, push) then pre-merge (fetch, merge, tests ok, typecheck fails)
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // rebase: git fetch
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // rebase: git rebase
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // rebase: git push
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // pre-merge: git fetch
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // pre-merge: git merge
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // pre-merge: npm test
      .mockRejectedValueOnce(new Error("type error")); // pre-merge: tsc --noEmit

    const result = await runParallelExecution(mockClient, makeConfig(), makePlan(issues));

    expect(mergeIssuePR).not.toHaveBeenCalled();
    const issue1 = result.results.find((r) => r.issueNumber === 1)!;
    expect(issue1.status).toBe("failed");
    expect(addComment).toHaveBeenCalledWith(1, expect.stringContaining("Type check failed"));
  });

  it("proceeds with merge when pre-merge verification passes", async () => {
    const issues = [makeIssue(1)];
    vi.mocked(buildExecutionGroups).mockReturnValue([{ group: 0, issues: [1] }]);
    vi.mocked(executeIssue).mockResolvedValueOnce(makeResult(1));
    vi.mocked(mergeIssuePR).mockResolvedValue({ success: true });

    const result = await runParallelExecution(mockClient, makeConfig(), makePlan(issues));

    expect(hasConflicts).toHaveBeenCalled();
    expect(createWorktree).toHaveBeenCalled();
    expect(mergeIssuePR).toHaveBeenCalledTimes(1);
    expect(removeWorktree).toHaveBeenCalled();
    const issue1 = result.results.find((r) => r.issueNumber === 1)!;
    expect(issue1.status).toBe("completed");
  });

  // --- Sequential execute-and-merge tests ---

  it("merges each issue before executing the next in sequential mode", async () => {
    const issues = [makeIssue(1), makeIssue(2)];
    vi.mocked(buildExecutionGroups).mockReturnValue([{ group: 0, issues: [1, 2] }]);

    const executionOrder: string[] = [];
    vi.mocked(executeIssue).mockImplementation(async (_c, _cfg, issue) => {
      executionOrder.push(`execute-${issue.number}`);
      return makeResult(issue.number);
    });
    vi.mocked(mergeIssuePR).mockImplementation(async () => {
      executionOrder.push("merge");
      return { success: true };
    });

    await runParallelExecution(
      mockClient,
      makeConfig({ sequentialExecution: true, autoMerge: true }),
      makePlan(issues),
    );

    // In sequential mode: execute #1 → merge → execute #2 → merge
    expect(executionOrder).toEqual(["execute-1", "merge", "execute-2", "merge"]);
    expect(executeIssue).toHaveBeenCalledTimes(2);
    expect(mergeIssuePR).toHaveBeenCalledTimes(2);
  });

  it("skips rebase in sequential mode (no worktree for rebase)", async () => {
    const issues = [makeIssue(1)];
    vi.mocked(buildExecutionGroups).mockReturnValue([{ group: 0, issues: [1] }]);
    vi.mocked(executeIssue).mockResolvedValueOnce(makeResult(1));
    vi.mocked(mergeIssuePR).mockResolvedValue({ success: true });

    const worktreeCallsBefore = vi.mocked(createWorktree).mock.calls.length;

    await runParallelExecution(
      mockClient,
      makeConfig({ sequentialExecution: true, autoMerge: true }),
      makePlan(issues),
    );

    // In sequential mode, createWorktree is called for pre-merge verification only (no rebase worktree)
    const worktreeCallsAfter = vi.mocked(createWorktree).mock.calls.length;
    const newCalls = worktreeCallsAfter - worktreeCallsBefore;
    // Pre-merge verification creates 1 worktree; rebase would add another
    expect(newCalls).toBe(1);
    expect(mergeIssuePR).toHaveBeenCalledTimes(1);
  });

  it("handles execution failure in sequential mode", async () => {
    const issues = [makeIssue(1), makeIssue(2)];
    vi.mocked(buildExecutionGroups).mockReturnValue([{ group: 0, issues: [1, 2] }]);
    vi.mocked(executeIssue)
      .mockRejectedValueOnce(new Error("session crashed"))
      .mockResolvedValueOnce(makeResult(2));
    vi.mocked(mergeIssuePR).mockResolvedValue({ success: true });

    const result = await runParallelExecution(
      mockClient,
      makeConfig({ sequentialExecution: true, autoMerge: true }),
      makePlan(issues),
    );

    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.status).toBe("failed");
    expect(result.results[1]!.status).toBe("completed");
    // Issue 2 should still execute and merge even though issue 1 failed
    expect(mergeIssuePR).toHaveBeenCalledTimes(1);
  });

  it("skips merge for zero-change completed issues", async () => {
    const issues = [makeIssue(1)];
    vi.mocked(buildExecutionGroups).mockReturnValue([{ group: 0, issues: [1] }]);
    vi.mocked(executeIssue).mockResolvedValueOnce({
      ...makeResult(1),
      filesChanged: [], // zero changes — already implemented
    });

    const result = await runParallelExecution(mockClient, makeConfig(), makePlan(issues));

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.status).toBe("completed");
    // Should NOT attempt merge for zero-change issues
    expect(mergeIssuePR).not.toHaveBeenCalled();
    expect(hasConflicts).not.toHaveBeenCalled();
  });

  it("skips merge for zero-change issues in sequential mode", async () => {
    const issues = [makeIssue(1), makeIssue(2)];
    vi.mocked(buildExecutionGroups).mockReturnValue([{ group: 0, issues: [1, 2] }]);
    vi.mocked(executeIssue)
      .mockResolvedValueOnce({ ...makeResult(1), filesChanged: [] }) // zero changes
      .mockResolvedValueOnce(makeResult(2)); // has changes
    vi.mocked(mergeIssuePR).mockResolvedValue({ success: true });

    const result = await runParallelExecution(
      mockClient,
      makeConfig({ sequentialExecution: true, autoMerge: true }),
      makePlan(issues),
    );

    expect(result.results).toHaveLength(2);
    // Only issue 2 should be merged (issue 1 has zero changes)
    expect(mergeIssuePR).toHaveBeenCalledTimes(1);
  });

  it("cleans up worktree even when pre-merge verification fails", async () => {
    const issues = [makeIssue(1)];
    vi.mocked(buildExecutionGroups).mockReturnValue([{ group: 0, issues: [1] }]);
    vi.mocked(executeIssue).mockResolvedValueOnce(makeResult(1));
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // rebase: git fetch
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // rebase: git rebase
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // rebase: git push
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // pre-merge: git fetch
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // pre-merge: git merge
      .mockRejectedValueOnce(new Error("test failure")); // pre-merge: npm test

    await runParallelExecution(mockClient, makeConfig(), makePlan(issues));

    expect(removeWorktree).toHaveBeenCalled();
  });
});
