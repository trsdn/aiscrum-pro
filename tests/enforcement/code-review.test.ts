import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCodeReview } from "../../src/enforcement/code-review.js";
import type { SprintConfig, SprintIssue } from "../../src/types.js";

vi.mock("../../src/acp/session-config.js", () => ({
  resolveSessionConfig: vi.fn().mockResolvedValue({
    mcpServers: [],
    model: "claude-sonnet-4",
    instructions: null,
  }),
}));

vi.mock("../../src/git/diff-analysis.js", () => ({
  diffStat: vi.fn().mockResolvedValue({
    linesChanged: 42,
    filesChanged: 2,
    files: ["src/foo.ts", "tests/foo.test.ts"],
  }),
}));

vi.mock("../../src/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

function createMockClient() {
  return {
    createSession: vi.fn().mockResolvedValue({ sessionId: "review-session-1" }),
    endSession: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn(),
    setModel: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
  };
}

const baseConfig: SprintConfig = {
  sprintNumber: 1,
  sprintPrefix: "Sprint",
  sprintSlug: "sprint",
  baseBranch: "main",
  projectPath: "/test/project",
  maxRetries: 1,
  maxParallelSessions: 2,
  sessionTimeoutMs: 60000,
  worktreeBase: "/tmp/worktrees",
  autoApproveTools: true,
  globalMcpServers: [],
  globalInstructions: [],
  phases: {},
};

const issue: SprintIssue = {
  number: 42,
  title: "Add foo feature",
  acceptanceCriteria: "Should do foo",
  points: 3,
};

describe("runCodeReview", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = createMockClient();
  });

  it("returns approved when reviewer says APPROVED", async () => {
    client.sendPrompt.mockResolvedValue({
      response:
        'Clean implementation, tests cover all cases.\n\n```json\n{"decision":"approved","reasoning":"Code is solid","summary":"Clean implementation","issues":[]}\n```',
    });

    const result = await runCodeReview(
      client as never,
      baseConfig,
      issue,
      "sprint/1/issue-42",
      "/tmp/worktrees/issue-42",
    );

    expect(result.approved).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("returns rejected with issues when reviewer says CHANGES_REQUESTED", async () => {
    client.sendPrompt.mockResolvedValue({
      response:
        'Missing error handling in edge case.\n\n```json\n{"decision":"changes_requested","reasoning":"edge cases not handled","summary":"Missing error handling","issues":["uncaught exception in parseInput when input is null","no validation for negative numbers"]}\n```',
    });

    const result = await runCodeReview(
      client as never,
      baseConfig,
      issue,
      "sprint/1/issue-42",
      "/tmp/worktrees/issue-42",
    );

    expect(result.approved).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toContain("uncaught exception");
    expect(result.issues[1]).toContain("no validation");
  });

  it("creates and tears down a session", async () => {
    client.sendPrompt.mockResolvedValue({
      response:
        '```json\n{"decision":"approved","reasoning":"ok","summary":"looks good","issues":[]}\n```',
    });

    await runCodeReview(
      client as never,
      baseConfig,
      issue,
      "sprint/1/issue-42",
      "/tmp/worktrees/issue-42",
    );

    expect(client.createSession).toHaveBeenCalledWith({
      cwd: "/tmp/worktrees/issue-42",
      mcpServers: [],
    });
    expect(client.endSession).toHaveBeenCalledWith("review-session-1");
  });

  it("sets the reviewer model", async () => {
    client.sendPrompt.mockResolvedValue({
      response: '```json\n{"decision":"approved","reasoning":"ok","summary":"ok","issues":[]}\n```',
    });

    await runCodeReview(
      client as never,
      baseConfig,
      issue,
      "sprint/1/issue-42",
      "/tmp/worktrees/issue-42",
    );

    expect(client.setModel).toHaveBeenCalledWith("review-session-1", "claude-sonnet-4");
  });

  it("ends session even if sendPrompt throws", async () => {
    client.sendPrompt.mockRejectedValue(new Error("timeout"));

    await expect(
      runCodeReview(
        client as never,
        baseConfig,
        issue,
        "sprint/1/issue-42",
        "/tmp/worktrees/issue-42",
      ),
    ).rejects.toThrow("timeout");

    expect(client.endSession).toHaveBeenCalledWith("review-session-1");
  });

  it("retries when response has no valid JSON", async () => {
    // First call returns no JSON, retry returns valid JSON
    client.sendPrompt.mockResolvedValueOnce({ response: "No JSON here" }).mockResolvedValueOnce({
      response: '```json\n{"decision":"approved","reasoning":"ok","summary":"ok","issues":[]}\n```',
    });

    const result = await runCodeReview(
      client as never,
      baseConfig,
      issue,
      "sprint/1/issue-42",
      "/tmp/worktrees/issue-42",
    );

    expect(result.approved).toBe(true);
    expect(client.sendPrompt).toHaveBeenCalledTimes(2);
  });

  it("returns feedback as full response text for session display", async () => {
    const fullResponse =
      'The code looks good overall.\n\n```json\n{"decision":"approved","reasoning":"solid code","summary":"approved","issues":[]}\n```';
    client.sendPrompt.mockResolvedValue({ response: fullResponse });

    const result = await runCodeReview(
      client as never,
      baseConfig,
      issue,
      "sprint/1/issue-42",
      "/tmp/worktrees/issue-42",
    );

    expect(result.feedback).toBe(fullResponse);
  });
});
