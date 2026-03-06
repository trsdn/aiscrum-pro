import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AcpClient } from "../../src/acp/client.js";
import type { SprintConfig, SprintResult, ReviewResult } from "../../src/types.js";

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("../../src/acp/session-config.js", () => ({
  applySessionSettings: vi.fn(),
  resolveSessionConfig: vi.fn().mockResolvedValue({
    mcpServers: [],
    instructions: "",
    model: undefined,
  }),
}));

vi.mock("../../src/github/issues.js", () => ({
  listIssues: vi.fn().mockResolvedValue([]),
  createIssue: vi.fn().mockResolvedValue({ number: 99, title: "mock" }),
}));

vi.mock("../../src/documentation/velocity.js", () => ({
  readVelocity: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/documentation/sprint-log.js", () => ({
  createSprintLog: vi.fn(),
}));

vi.mock("../../src/logger.js", () => {
  const mock = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { logger: mock, appendErrorLog: vi.fn() };
});

vi.mock("../../src/metrics.js", () => ({
  calculateSprintMetrics: vi.fn().mockReturnValue({
    planned: 1,
    completed: 1,
    failed: 0,
    pointsPlanned: 2,
    pointsCompleted: 2,
    velocity: 2,
    avgDuration: 5000,
    firstPassRate: 1,
    driftIncidents: 0,
  }),
  topFailedGates: vi.fn().mockReturnValue([]),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn().mockResolvedValue("Template {{SPRINT_NUMBER}}"),
  },
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { runRefinement } from "../../src/ceremonies/refinement.js";
import { runSprintReview } from "../../src/ceremonies/review.js";
import { runSprintRetro } from "../../src/ceremonies/retro.js";
import { listIssues, createIssue } from "../../src/github/issues.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeMockClient() {
  return {
    createSession: vi.fn().mockResolvedValue({
      sessionId: "session-1",
      availableModes: [],
      currentMode: "",
      availableModels: [],
      currentModel: "",
    }),
    sendPrompt: vi.fn().mockResolvedValue({ response: "", stopReason: "end_turn" }),
    endSession: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
  } as unknown as AcpClient;
}

const config: SprintConfig = {
  sprintNumber: 1,
  sprintPrefix: "Sprint",
  sprintSlug: "sprint",
  projectPath: "/tmp/project",
  baseBranch: "main",
  worktreeBase: "../wt",
  branchPattern: "{prefix}/{sprint}/issue-{issue}",
  maxParallelSessions: 4,
  maxIssuesPerSprint: 8,
  maxDriftIncidents: 2,
  maxRetries: 2,
  enableChallenger: true,
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
};

const sprintResult: SprintResult = {
  results: [
    {
      issueNumber: 1,
      status: "completed" as const,
      qualityGatePassed: true,
      qualityDetails: { passed: true, checks: [] },
      branch: "feat/issue-1",
      duration_ms: 5000,
      filesChanged: ["src/a.ts"],
      retryCount: 0,
      points: 2,
    },
  ],
  sprint: 1,
  parallelizationRatio: 1,
  avgWorktreeLifetime: 5000,
  mergeConflicts: 0,
};

const reviewResult: ReviewResult = {
  summary: "Sprint complete",
  demoItems: ["Feature A"],
  velocityUpdate: "2.3",
  openItems: [],
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("runRefinement", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty array when no idea issues found", async () => {
    vi.mocked(listIssues).mockResolvedValueOnce([]);
    const client = makeMockClient();

    const result = await runRefinement(client, config);

    expect(result).toEqual([]);
    expect(client.sendPrompt).not.toHaveBeenCalled();
  });

  it("refines idea issues and returns RefinedIssue array", async () => {
    vi.mocked(listIssues).mockResolvedValueOnce([
      {
        number: 1,
        title: "Idea",
        body: "",
        labels: [{ name: "type:idea" }],
        state: "OPEN",
      },
    ] as never);

    const client = makeMockClient();
    vi.mocked(client.sendPrompt).mockResolvedValueOnce({
      response: JSON.stringify({
        refined_issues: [{ number: 1, title: "Feature A", ice_score: 320 }],
      }),
      stopReason: "end_turn",
    });

    const result = await runRefinement(client, config);

    expect(result).toEqual([{ number: 1, title: "Feature A", ice_score: 320 }]);
    expect(client.endSession).toHaveBeenCalledWith("session-1");
  });

  it("ends ACP session even on error", async () => {
    vi.mocked(listIssues).mockResolvedValueOnce([
      {
        number: 1,
        title: "Idea",
        body: "",
        labels: [{ name: "type:idea" }],
        state: "OPEN",
      },
    ] as never);

    const client = makeMockClient();
    vi.mocked(client.sendPrompt).mockRejectedValueOnce(new Error("ACP failure"));

    await expect(runRefinement(client, config)).rejects.toThrow("ACP failure");
    expect(client.endSession).toHaveBeenCalledWith("session-1");
  });
});

describe("runSprintReview", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns review result from ACP", async () => {
    const client = makeMockClient();
    vi.mocked(client.sendPrompt).mockResolvedValueOnce({
      response: JSON.stringify({
        summary: "Sprint complete",
        demoItems: ["Feature A"],
        velocityUpdate: "2.3",
        openItems: [],
      }),
      stopReason: "end_turn",
    });

    const result = await runSprintReview(client, config, sprintResult);

    expect(result).toEqual({
      summary: "Sprint complete",
      demoItems: ["Feature A"],
      velocityUpdate: "2.3",
      openItems: [],
    });
    expect(client.endSession).toHaveBeenCalledWith("session-1");
  });

  it("ends ACP session even on error", async () => {
    const client = makeMockClient();
    vi.mocked(client.sendPrompt).mockRejectedValueOnce(new Error("ACP failure"));

    await expect(runSprintReview(client, config, sprintResult)).rejects.toThrow("ACP failure");
    expect(client.endSession).toHaveBeenCalledWith("session-1");
  });
});

describe("runSprintRetro", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns retro result from ACP", async () => {
    const client = makeMockClient();
    vi.mocked(client.sendPrompt).mockResolvedValueOnce({
      response: JSON.stringify({
        wentWell: ["Good tests"],
        wentBadly: ["Slow CI"],
        improvements: [],
        previousImprovementsChecked: true,
      }),
      stopReason: "end_turn",
    });

    const result = await runSprintRetro(client, config, sprintResult, reviewResult);

    expect(result).toMatchObject({
      wentWell: ["Good tests"],
      wentBadly: ["Slow CI"],
      improvements: [],
      previousImprovementsChecked: true,
    });
    expect(client.endSession).toHaveBeenCalledWith("session-1");
  });

  it("skips non-auto-applicable improvements with warning", async () => {
    const client = makeMockClient();
    vi.mocked(client.sendPrompt).mockResolvedValueOnce({
      response: JSON.stringify({
        wentWell: [],
        wentBadly: [],
        improvements: [
          {
            title: "Fix CI",
            description: "Speed up",
            autoApplicable: false,
            target: "process",
          },
        ],
        previousImprovementsChecked: true,
      }),
      stopReason: "end_turn",
    });

    await runSprintRetro(client, config, sprintResult, reviewResult);

    // Non-auto-applicable improvements are skipped — no issues created, no ACP session
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("ends ACP session even on error", async () => {
    const client = makeMockClient();
    vi.mocked(client.sendPrompt).mockRejectedValueOnce(new Error("ACP failure"));

    await expect(runSprintRetro(client, config, sprintResult, reviewResult)).rejects.toThrow(
      "ACP failure",
    );
    expect(client.endSession).toHaveBeenCalledWith("session-1");
  });

  it("skips improvements with undefined or empty title", async () => {
    const client = makeMockClient();
    vi.mocked(client.sendPrompt).mockResolvedValueOnce({
      response: JSON.stringify({
        wentWell: [],
        wentBadly: [],
        improvements: [
          { title: undefined, description: "desc", autoApplicable: true, target: "process" },
          { title: "", description: "desc2", autoApplicable: true, target: "process" },
          { title: "Valid Fix", description: undefined, autoApplicable: true, target: "process" },
          { title: "Real Fix", description: "Real desc", autoApplicable: true, target: "process" },
        ],
        previousImprovementsChecked: true,
      }),
      stopReason: "end_turn",
    });

    await runSprintRetro(client, config, sprintResult, reviewResult);

    // Invalid improvements skipped (undefined/empty title, undefined description).
    // "Real Fix" has target "process" → creates a GitHub issue instead of ACP auto-apply.
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "[Retro] Real Fix",
        labels: ["human-decision-needed", "type:improvement"],
      }),
    );
    // Only 1 session: retro. No ACP apply session for process target.
    expect(client.createSession).toHaveBeenCalledTimes(1);
  });
});
