import { describe, it, expect, vi, beforeEach } from "vitest";
import { substitutePrompt, extractJson } from "../../src/ceremonies/helpers.js";
import { runSprintPlanning } from "../../src/ceremonies/planning.js";
import type { SprintConfig, SprintPlan } from "../../src/types.js";

// --- substitutePrompt ---

describe("substitutePrompt", () => {
  it("replaces single placeholder", () => {
    expect(substitutePrompt("Hello {{NAME}}", { NAME: "World" })).toBe("Hello World");
  });

  it("replaces multiple distinct placeholders", () => {
    const tpl = "Sprint {{NUM}} for {{PROJECT}}";
    expect(substitutePrompt(tpl, { NUM: "5", PROJECT: "myapp" })).toBe("Sprint 5 for myapp");
  });

  it("replaces repeated occurrences of the same placeholder", () => {
    const tpl = "{{X}} and {{X}} again";
    expect(substitutePrompt(tpl, { X: "ok" })).toBe("ok and ok again");
  });

  it("leaves unmatched placeholders untouched", () => {
    const tpl = "{{A}} {{B}}";
    expect(substitutePrompt(tpl, { A: "hi" })).toBe("hi {{B}}");
  });

  it("handles empty vars", () => {
    expect(substitutePrompt("no vars", {})).toBe("no vars");
  });
});

// --- extractJson ---

describe("extractJson", () => {
  it("extracts JSON from fenced code block", () => {
    const text = 'Some text\n```json\n{"a":1}\n```\nmore text';
    expect(extractJson(text)).toEqual({ a: 1 });
  });

  it("extracts JSON from plain fenced block", () => {
    const text = 'Prefix\n```\n{"b":2}\n```';
    expect(extractJson(text)).toEqual({ b: 2 });
  });

  it("extracts JSON array from text", () => {
    const text = "Here is the data: [1,2,3] and done.";
    expect(extractJson(text)).toEqual([1, 2, 3]);
  });

  it("extracts JSON object from plain text", () => {
    const text = 'result: {"key":"val"} end';
    expect(extractJson(text)).toEqual({ key: "val" });
  });

  it("handles nested braces", () => {
    const text = '{"a":{"b":{"c":1}}}';
    expect(extractJson(text)).toEqual({ a: { b: { c: 1 } } });
  });

  it("handles strings with braces inside", () => {
    const text = '{"msg":"hello {world}"}';
    expect(extractJson(text)).toEqual({ msg: "hello {world}" });
  });

  it("throws when no JSON is present", () => {
    expect(() => extractJson("no json here")).toThrow("No JSON found");
  });

  it("throws on empty string", () => {
    expect(() => extractJson("")).toThrow("No JSON found");
  });

  it("throws on whitespace-only string", () => {
    expect(() => extractJson("   \n\n  ")).toThrow("No JSON found");
  });

  it("handles JSON with escaped quotes in strings", () => {
    const text = '{"msg":"say \\"hello\\""}';
    expect(extractJson(text)).toEqual({ msg: 'say "hello"' });
  });

  it("extracts first JSON when multiple objects exist", () => {
    const text = '{"first":1} and {"second":2}';
    expect(extractJson(text)).toEqual({ first: 1 });
  });

  it("handles fenced block with extra whitespace", () => {
    const text = 'text\n```json\n  \n{"data": true}\n  \n```\nmore';
    expect(extractJson(text)).toEqual({ data: true });
  });
});

// --- runSprintPlanning (mocked) ---

vi.mock("../../src/acp/session-config.js", () => ({
  resolveSessionConfig: vi.fn().mockResolvedValue({
    mcpServers: [],
    instructions: "",
    model: undefined,
  }),
}));

// Mock external dependencies
vi.mock("../../src/github/issues.js", () => ({
  listIssues: vi.fn(),
}));
vi.mock("../../src/github/labels.js", () => ({
  setLabel: vi.fn(),
  setStatusLabel: vi.fn(),
  getLabels: vi.fn().mockResolvedValue([]),
  removeLabel: vi.fn(),
}));
vi.mock("../../src/github/milestones.js", () => ({
  getMilestone: vi.fn(),
  createMilestone: vi.fn(),
  setMilestone: vi.fn(),
}));
vi.mock("../../src/documentation/sprint-log.js", () => ({
  createSprintLog: vi.fn(),
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
    readFile: vi.fn().mockResolvedValue("Sprint {{SPRINT_NUMBER}} plan for {{PROJECT_NAME}}"),
  },
}));

const { listIssues } = await import("../../src/github/issues.js");
const { setStatusLabel } = await import("../../src/github/labels.js");
const { getMilestone, createMilestone, setMilestone } =
  await import("../../src/github/milestones.js");
const { createSprintLog } = await import("../../src/documentation/sprint-log.js");

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

const planResponse: SprintPlan = {
  sprintNumber: 3,
  sprint_issues: [
    {
      number: 10,
      title: "feat(api): search",
      ice_score: 300,
      depends_on: [],
      acceptanceCriteria: "given query, returns results",
      expectedFiles: ["src/api.ts"],
      points: 3,
    },
    {
      number: 12,
      title: "fix(auth): token",
      ice_score: 400,
      depends_on: [],
      acceptanceCriteria: "token refreshes correctly",
      expectedFiles: ["src/auth.ts"],
      points: 2,
    },
  ],
  execution_groups: [[10, 12]],
  estimated_points: 5,
  rationale: "Prioritised critical bug fix",
};

function makeMockClient() {
  return {
    createSession: vi.fn().mockResolvedValue({
      sessionId: "session-123",
      availableModes: [],
      currentMode: "",
      availableModels: [],
      currentModel: "",
    }),
    sendPrompt: vi.fn().mockResolvedValue({
      response: "```json\n" + JSON.stringify(planResponse) + "\n```",
      stopReason: "end_turn",
    }),
    endSession: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
  };
}

describe("runSprintPlanning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a session, sends prompt, and labels issues", async () => {
    const mockClient = makeMockClient();
    vi.mocked(listIssues).mockResolvedValue([]);
    vi.mocked(getMilestone).mockResolvedValue(undefined);
    vi.mocked(createMilestone).mockResolvedValue({
      title: "Sprint 3",
      number: 1,
      description: "",
      state: "open",
    });
    vi.mocked(setStatusLabel).mockResolvedValue(undefined);
    vi.mocked(setMilestone).mockResolvedValue(undefined);
    vi.mocked(createSprintLog).mockReturnValue("/tmp/log.md");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plan = await runSprintPlanning(mockClient as any, makeConfig());

    expect(mockClient.createSession).toHaveBeenCalledWith({
      cwd: "/tmp/test-project",
      mcpServers: [],
    });
    expect(mockClient.sendPrompt).toHaveBeenCalledOnce();
    expect(mockClient.endSession).toHaveBeenCalledWith("session-123");

    expect(plan.sprintNumber).toBe(3);
    expect(plan.sprint_issues).toHaveLength(2);
    expect(plan.estimated_points).toBe(5);

    // Each issue gets label + milestone
    expect(setStatusLabel).toHaveBeenCalledTimes(2);
    expect(setStatusLabel).toHaveBeenCalledWith(10, "status:planned");
    expect(setStatusLabel).toHaveBeenCalledWith(12, "status:planned");
    expect(setMilestone).toHaveBeenCalledTimes(2);

    // Milestone created since it didn't exist
    expect(createMilestone).toHaveBeenCalledOnce();

    // Sprint log created
    expect(createSprintLog).toHaveBeenCalledWith(
      3,
      planResponse.rationale,
      2,
      undefined,
      "Sprint",
      "sprint",
    );
  });

  it("skips milestone creation when it already exists", async () => {
    const mockClient = makeMockClient();
    vi.mocked(listIssues).mockResolvedValue([]);
    vi.mocked(getMilestone).mockResolvedValue({
      title: "Sprint 3",
      number: 1,
      description: "",
      state: "open",
    });
    vi.mocked(setStatusLabel).mockResolvedValue(undefined);
    vi.mocked(setMilestone).mockResolvedValue(undefined);
    vi.mocked(createSprintLog).mockReturnValue("/tmp/log.md");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runSprintPlanning(mockClient as any, makeConfig());

    expect(createMilestone).not.toHaveBeenCalled();
  });

  it("ends session even when all planning attempts fail", async () => {
    const mockClient = makeMockClient();
    mockClient.sendPrompt.mockRejectedValue(new Error("timeout"));
    vi.mocked(listIssues).mockResolvedValue([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(runSprintPlanning(mockClient as any, makeConfig())).rejects.toThrow("timeout");

    // Retried once before giving up
    expect(mockClient.sendPrompt).toHaveBeenCalledTimes(2);
    expect(mockClient.endSession).toHaveBeenCalledWith("session-123");
  });

  it("retries planning on first failure and succeeds on second attempt", async () => {
    const mockClient = makeMockClient();
    mockClient.sendPrompt
      .mockRejectedValueOnce(new Error("Prompt timed out"))
      .mockResolvedValueOnce({
        response: "```json\n" + JSON.stringify(planResponse) + "\n```",
        stopReason: "end_turn",
      });
    vi.mocked(listIssues).mockResolvedValue([]);
    vi.mocked(getMilestone).mockResolvedValue({
      title: "Sprint 3",
      number: 1,
      description: "",
      state: "open",
    });
    vi.mocked(setStatusLabel).mockResolvedValue(undefined);
    vi.mocked(setMilestone).mockResolvedValue(undefined);
    vi.mocked(createSprintLog).mockReturnValue("/tmp/log.md");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plan = await runSprintPlanning(mockClient as any, makeConfig());

    expect(mockClient.sendPrompt).toHaveBeenCalledTimes(2);
    expect(plan.sprintNumber).toBe(3);
    expect(plan.sprint_issues).toHaveLength(2);
  });
});
