import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SprintConfig, SprintIssue, QualityResult } from "../../src/types.js";

vi.mock("../../src/acp/session-config.js", () => ({
  resolveSessionConfig: vi.fn().mockResolvedValue({
    mcpServers: [],
    instructions: "",
    model: undefined,
  }),
}));

// Mock all external dependencies
vi.mock("../../src/git/worktree.js", () => ({
  createWorktree: vi.fn().mockResolvedValue(undefined),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/enforcement/quality-gate.js", () => ({
  runQualityGate: vi.fn(),
}));

vi.mock("../../src/documentation/huddle.js", () => ({
  formatHuddleComment: vi.fn().mockReturnValue("huddle comment"),
  formatSprintLogEntry: vi.fn().mockReturnValue("log entry"),
}));

vi.mock("../../src/documentation/sprint-log.js", () => ({
  appendToSprintLog: vi.fn(),
}));

vi.mock("../../src/github/issues.js", () => ({
  addComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/github/labels.js", () => ({
  setLabel: vi.fn().mockResolvedValue(undefined),
  setStatusLabel: vi.fn().mockResolvedValue(undefined),
  getLabels: vi.fn().mockResolvedValue([]),
  removeLabel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/git/diff-analysis.js", () => ({
  getChangedFiles: vi.fn().mockResolvedValue(["src/foo.ts"]),
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

vi.mock("node:child_process", () => {
  const cb = vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: null, result: { stdout: string; stderr: string }) => void,
    ) => {
      callback(null, { stdout: "diff --git a/src/foo.ts b/src/foo.ts\n+added line", stderr: "" });
    },
  );
  return { execFile: cb };
});

vi.mock("node:util", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:util")>();
  return {
    ...original,
    promisify: (fn: unknown) => {
      if (typeof fn === "function" && (fn as { __esModule?: boolean }).__esModule !== true) {
        return (...args: unknown[]) => {
          return new Promise((resolve, reject) => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
            (fn as Function)(...args, (err: unknown, ...result: unknown[]) => {
              if (err) reject(err);
              else if (result.length === 1) resolve(result[0]);
              else resolve(result);
            });
          });
        };
      }
      return original.promisify(fn as never);
    },
  };
});

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn().mockImplementation((filePath: string) => {
      if (filePath.includes("item-planner")) {
        return Promise.resolve("Plan for issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}");
      }
      if (filePath.includes("tdd")) {
        return Promise.resolve(
          "TDD tests for issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}\nPlan: {{IMPLEMENTATION_PLAN}}",
        );
      }
      if (filePath.includes("acceptance-review")) {
        return Promise.resolve(
          "Review AC for issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}\nCriteria: {{ACCEPTANCE_CRITERIA}}\nDiff: {{DIFF}}",
        );
      }
      return Promise.resolve("Worker prompt for issue #{{ISSUE_NUMBER}}");
    }),
  },
}));

const { createWorktree, removeWorktree } = await import("../../src/git/worktree.js");
const { runQualityGate } = await import("../../src/enforcement/quality-gate.js");
const { formatHuddleComment, formatSprintLogEntry } =
  await import("../../src/documentation/huddle.js");
const { appendToSprintLog } = await import("../../src/documentation/sprint-log.js");
const { addComment } = await import("../../src/github/issues.js");
const { setStatusLabel } = await import("../../src/github/labels.js");
await import("../../src/git/diff-analysis.js");

const { executeIssue } = await import("../../src/ceremonies/execution.js");

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
    enableTdd: false,
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

function makeIssue(overrides: Partial<SprintIssue> = {}): SprintIssue {
  return {
    number: 42,
    title: "feat(api): add search endpoint",
    ice_score: 300,
    depends_on: [],
    acceptanceCriteria: "given query, returns results",
    expectedFiles: ["src/api.ts"],
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
    sendPrompt: vi.fn().mockImplementation((_sid: string, prompt: string) => {
      // AC review prompts come from the acceptance-review template
      if (typeof prompt === "string" && prompt.includes("Review AC for issue")) {
        return Promise.resolve({
          response: JSON.stringify({
            approved: true,
            reasoning: "all good",
            summary: "Criteria met",
            criteria: [],
          }),
          stopReason: "end_turn",
        });
      }
      return Promise.resolve({ response: "Done implementing issue", stopReason: "end_turn" });
    }),
    endSession: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
    getSessionOutput: vi.fn().mockReturnValue([]),
  };
}

const passingQuality: QualityResult = {
  passed: true,
  checks: [
    { name: "tests-pass", passed: true, detail: "Tests passed", category: "test" },
    { name: "lint-clean", passed: true, detail: "Lint clean", category: "lint" },
  ],
};

const failingQuality: QualityResult = {
  passed: false,
  checks: [
    { name: "tests-pass", passed: false, detail: "2 tests failed", category: "test" },
    { name: "lint-clean", passed: true, detail: "Lint clean", category: "lint" },
  ],
};

// --- executeIssue ---

describe("executeIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes full flow with passing quality gate", async () => {
    const mockClient = makeMockClient();
    vi.mocked(runQualityGate).mockResolvedValue(passingQuality);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeIssue(mockClient as any, makeConfig(), makeIssue());

    // Label set to in-progress first
    expect(setStatusLabel).toHaveBeenCalledWith(42, "status:in-progress");

    // Worktree created
    expect(createWorktree).toHaveBeenCalledWith({
      path: "/tmp/worktrees/issue-42",
      branch: "sprint/3/issue-42",
      base: "main",
    });

    // ACP session created in worktree directory
    expect(mockClient.createSession).toHaveBeenCalledWith({
      cwd: "/tmp/worktrees/issue-42",
      mcpServers: [],
    });

    // Prompt sent (planner + developer + AC review attempt)
    expect(mockClient.sendPrompt).toHaveBeenCalledTimes(3);

    // Session ended
    expect(mockClient.endSession).toHaveBeenCalledWith("session-abc");

    // Quality gate ran
    expect(runQualityGate).toHaveBeenCalledOnce();

    // Huddle posted
    expect(formatHuddleComment).toHaveBeenCalledOnce();
    expect(addComment).toHaveBeenCalledWith(42, "huddle comment");
    expect(formatSprintLogEntry).toHaveBeenCalledOnce();
    expect(appendToSprintLog).toHaveBeenCalledWith(3, "log entry", undefined, "sprint");

    // Final label
    expect(setStatusLabel).toHaveBeenCalledWith(42, "status:done");

    // Worktree removed
    expect(removeWorktree).toHaveBeenCalledWith("/tmp/worktrees/issue-42");

    // Result
    expect(result.issueNumber).toBe(42);
    expect(result.status).toBe("completed");
    expect(result.qualityGatePassed).toBe(true);
    expect(result.branch).toBe("sprint/3/issue-42");
    expect(result.points).toBe(3);
    expect(result.filesChanged).toEqual(["src/foo.ts"]);
  });

  it("marks issue as blocked when quality gate fails after retries", async () => {
    const mockClient = makeMockClient();
    vi.mocked(runQualityGate).mockResolvedValue(failingQuality);

    const config = makeConfig({ maxRetries: 1 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeIssue(mockClient as any, config, makeIssue());

    expect(result.status).toBe("failed");
    expect(result.qualityGatePassed).toBe(false);

    // Final label should be blocked
    expect(setStatusLabel).toHaveBeenCalledWith(42, "status:blocked");
  });

  it("sends QG retry feedback to same developer session instead of creating new one", async () => {
    const mockClient = makeMockClient();
    vi.mocked(runQualityGate)
      .mockResolvedValueOnce(failingQuality) // first QG fails
      .mockResolvedValueOnce(passingQuality); // retry QG passes

    const config = makeConfig({ maxRetries: 1 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeIssue(mockClient as any, config, makeIssue());

    expect(result.status).toBe("completed");

    // 3 sessions created: planner + developer + AC reviewer (no new session for QG retry)
    expect(mockClient.createSession).toHaveBeenCalledTimes(3);

    // 4 sendPrompt calls: planner + developer + QG retry feedback + AC review attempt
    expect(mockClient.sendPrompt).toHaveBeenCalledTimes(4);

    // The retry prompt goes to the developer session (same sessionId)
    const retryCall = mockClient.sendPrompt.mock.calls[2];
    expect(retryCall[0]).toBe("session-abc"); // same session
    expect(retryCall[1]).toContain("Quality Gate Failed");
  });

  it("cleans up worktree even when ACP session fails", async () => {
    const mockClient = makeMockClient();
    mockClient.sendPrompt.mockRejectedValue(new Error("session timeout"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeIssue(mockClient as any, makeConfig(), makeIssue());

    // Should return failed result (not throw)
    expect(result.status).toBe("failed");

    // Worktree should still be removed
    expect(removeWorktree).toHaveBeenCalledWith("/tmp/worktrees/issue-42");

    // Session should still be ended
    expect(mockClient.endSession).toHaveBeenCalledWith("session-abc");
  });

  it("cleans up worktree even when worktree removal fails", async () => {
    const mockClient = makeMockClient();
    vi.mocked(runQualityGate).mockResolvedValue(passingQuality);
    vi.mocked(removeWorktree).mockRejectedValue(new Error("rm failed"));

    // Should not throw despite worktree removal failure
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeIssue(mockClient as any, makeConfig(), makeIssue());

    expect(result.status).toBe("completed");
    expect(removeWorktree).toHaveBeenCalled();
  });

  it("includes cleanupWarning in huddle entry when worktree removal fails", async () => {
    const mockClient = makeMockClient();
    vi.mocked(runQualityGate).mockResolvedValue(passingQuality);
    vi.mocked(removeWorktree).mockRejectedValue(new Error("rm failed"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeIssue(mockClient as any, makeConfig(), makeIssue());

    // Huddle entry should include cleanupWarning with the worktree path
    expect(formatHuddleComment).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanupWarning: expect.stringContaining("/tmp/worktrees/issue-42"),
      }),
    );
    expect(formatSprintLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanupWarning: expect.stringContaining("/tmp/worktrees/issue-42"),
      }),
    );
  });

  it("does not include cleanupWarning when worktree removal succeeds", async () => {
    const mockClient = makeMockClient();
    vi.mocked(runQualityGate).mockResolvedValue(passingQuality);
    vi.mocked(removeWorktree).mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeIssue(mockClient as any, makeConfig(), makeIssue());

    expect(formatHuddleComment).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanupWarning: undefined,
      }),
    );
  });

  it("captures zero-change diagnostic with task-not-applicable outcome when no error", async () => {
    const mockClient = makeMockClient();
    vi.mocked(runQualityGate).mockResolvedValue(passingQuality);
    const { getChangedFiles } = await import("../../src/git/diff-analysis.js");
    vi.mocked(getChangedFiles).mockResolvedValue([]);

    mockClient.getSessionOutput.mockReturnValue([
      "Processing issue...",
      "No changes needed for this task",
      "Task completed successfully",
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeIssue(mockClient as any, makeConfig(), makeIssue());

    expect(result.status).toBe("failed");
    expect(formatHuddleComment).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        filesChanged: [],
        zeroChangeDiagnostic: expect.objectContaining({
          workerOutcome: "task-not-applicable",
          timedOut: false,
          lastOutputLines: expect.arrayContaining([
            "Processing issue...",
            "No changes needed for this task",
            "Task completed successfully",
          ]),
        }),
      }),
    );
  });

  it("captures zero-change diagnostic with worker-error outcome on timeout", async () => {
    const mockClient = makeMockClient();
    mockClient.sendPrompt.mockRejectedValue(new Error("Prompt timed out after 600000ms"));
    vi.mocked(runQualityGate).mockResolvedValue(passingQuality);
    const { getChangedFiles } = await import("../../src/git/diff-analysis.js");
    vi.mocked(getChangedFiles).mockResolvedValue([]);

    mockClient.getSessionOutput.mockReturnValue([
      "Starting implementation...",
      "Processing files...",
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeIssue(mockClient as any, makeConfig(), makeIssue());

    expect(result.status).toBe("failed");
    expect(formatHuddleComment).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        filesChanged: [],
        errorMessage: "Prompt timed out after 600000ms",
      }),
    );
  });

  it("captures zero-change diagnostic with worker-error outcome when output contains errors", async () => {
    const mockClient = makeMockClient();
    vi.mocked(runQualityGate).mockResolvedValue(passingQuality);
    const { getChangedFiles } = await import("../../src/git/diff-analysis.js");
    vi.mocked(getChangedFiles).mockResolvedValue([]);

    mockClient.getSessionOutput.mockReturnValue([
      "Starting implementation...",
      "Error: Cannot find module 'src/foo.ts'",
      "  at Module._resolveFilename",
      "FAIL: test suite failed",
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeIssue(mockClient as any, makeConfig(), makeIssue());

    expect(result.status).toBe("failed");
    expect(formatHuddleComment).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        filesChanged: [],
        zeroChangeDiagnostic: expect.objectContaining({
          workerOutcome: "worker-error",
          timedOut: false,
          lastOutputLines: expect.arrayContaining([expect.stringContaining("Error:")]),
        }),
      }),
    );
  });

  it("runs TDD phase between plan and implement when enableTdd is true", async () => {
    const mockClient = makeMockClient();
    vi.mocked(runQualityGate).mockResolvedValue(passingQuality);
    const { getChangedFiles } = await import("../../src/git/diff-analysis.js");
    vi.mocked(getChangedFiles).mockResolvedValue(["src/foo.ts"]);

    const config = makeConfig({ enableTdd: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeIssue(mockClient as any, config, makeIssue());

    expect(result.status).toBe("completed");

    // 4 sessions: planner + test-engineer + developer + AC reviewer
    expect(mockClient.createSession).toHaveBeenCalledTimes(4);

    // 4 sendPrompt calls: planner + test-engineer + developer + AC review attempt
    expect(mockClient.sendPrompt).toHaveBeenCalledTimes(4);

    // Verify the TDD prompt was sent (2nd sendPrompt call)
    const tddPromptCall = mockClient.sendPrompt.mock.calls[1];
    expect(tddPromptCall[1]).toContain("TDD tests for issue #42");
  });

  it("skips TDD phase when enableTdd is false", async () => {
    const mockClient = makeMockClient();
    vi.mocked(runQualityGate).mockResolvedValue(passingQuality);
    const { getChangedFiles } = await import("../../src/git/diff-analysis.js");
    vi.mocked(getChangedFiles).mockResolvedValue(["src/foo.ts"]);

    const config = makeConfig({ enableTdd: false });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeIssue(mockClient as any, config, makeIssue());

    expect(result.status).toBe("completed");

    // 3 sessions: planner + developer + AC reviewer (no test-engineer)
    expect(mockClient.createSession).toHaveBeenCalledTimes(3);

    // 3 sendPrompt calls: planner + developer + AC review attempt
    expect(mockClient.sendPrompt).toHaveBeenCalledTimes(3);
  });

  it("runs acceptance criteria review after code review passes", async () => {
    const mockClient = makeMockClient();
    vi.mocked(runQualityGate).mockResolvedValue(passingQuality);
    const { getChangedFiles } = await import("../../src/git/diff-analysis.js");
    vi.mocked(getChangedFiles).mockResolvedValue(["src/foo.ts"]);

    // AC review returns approved (4th sendPrompt: planner + developer + code-review + AC-review)
    mockClient.sendPrompt.mockImplementation((_sid: string, prompt: string) => {
      if (typeof prompt === "string" && prompt.includes("Review AC for issue")) {
        return Promise.resolve({
          response: JSON.stringify({
            approved: true,
            criteria: [{ criterion: "returns results", passed: true, evidence: "implemented" }],
            summary: "All criteria met",
          }),
          stopReason: "end_turn",
        });
      }
      return Promise.resolve({ response: "Done implementing issue", stopReason: "end_turn" });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeIssue(mockClient as any, makeConfig(), makeIssue());

    expect(result.status).toBe("completed");
    // 3 sessions: planner + developer + AC-reviewer (code review fails internally)
    expect(mockClient.createSession).toHaveBeenCalledTimes(3);
    // AC review result posted as comment
    expect(addComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Acceptance Criteria Review"),
    );
  });

  it("sends feedback to developer when AC review fails", async () => {
    const mockClient = makeMockClient();
    vi.mocked(runQualityGate).mockResolvedValue(passingQuality);
    const { getChangedFiles } = await import("../../src/git/diff-analysis.js");
    vi.mocked(getChangedFiles).mockResolvedValue(["src/foo.ts"]);

    mockClient.sendPrompt.mockImplementation((_sid: string, prompt: string) => {
      if (typeof prompt === "string" && prompt.includes("Review AC for issue")) {
        return Promise.resolve({
          response: JSON.stringify({
            approved: false,
            reasoning: "Missing search endpoint implementation",
            criteria: [
              { criterion: "returns results", passed: false, concern: "no endpoint found" },
            ],
          }),
          stopReason: "end_turn",
        });
      }
      return Promise.resolve({ response: "Done implementing issue", stopReason: "end_turn" });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeIssue(mockClient as any, makeConfig(), makeIssue());

    // Developer session should receive AC failure feedback
    const feedbackCalls = mockClient.sendPrompt.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[1] === "string" && call[1].includes("Acceptance Criteria Review Failed"),
    );
    expect(feedbackCalls.length).toBe(1);
    expect(feedbackCalls[0][1]).toContain("Missing search endpoint implementation");
  });

  it("AC review failure is non-blocking when it throws", async () => {
    const mockClient = makeMockClient();
    vi.mocked(runQualityGate).mockResolvedValue(passingQuality);
    const { getChangedFiles } = await import("../../src/git/diff-analysis.js");
    vi.mocked(getChangedFiles).mockResolvedValue(["src/foo.ts"]);

    mockClient.sendPrompt.mockImplementation((_sid: string, prompt: string) => {
      if (typeof prompt === "string" && prompt.includes("Review AC for issue")) {
        return Promise.reject(new Error("ACP session timeout"));
      }
      return Promise.resolve({ response: "Done implementing issue", stopReason: "end_turn" });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeIssue(mockClient as any, makeConfig(), makeIssue());

    // Should still complete despite AC review failure
    expect(result.status).toBe("completed");
    expect(result.qualityGatePassed).toBe(true);
  });
});
