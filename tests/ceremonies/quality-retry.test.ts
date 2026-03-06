import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SprintConfig, SprintIssue, QualityResult } from "../../src/types.js";

vi.mock("../../src/acp/session-config.js", () => ({
  applySessionSettings: vi.fn(),
  resolveSessionConfig: vi.fn().mockResolvedValue({
    mcpServers: [],
    instructions: "",
    model: undefined,
  }),
}));

vi.mock("../../src/enforcement/quality-gate.js", () => ({
  runQualityGate: vi.fn(),
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

const { runQualityGate } = await import("../../src/enforcement/quality-gate.js");

const { handleQualityFailure, buildQualityGateConfig, DEFAULT_QUALITY_GATE_CONFIG } =
  await import("../../src/ceremonies/quality-retry.js");

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
    sendPrompt: vi.fn().mockResolvedValue({
      response: "Done implementing issue",
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

// --- handleQualityFailure ---

describe("handleQualityFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns failing result when retryCount >= maxRetries", async () => {
    const mockClient = makeMockClient();
    const config = makeConfig({ maxRetries: 2 });

    const result = await handleQualityFailure(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockClient as any,
      config,
      makeIssue(),
      "/tmp/worktrees/issue-42",
      failingQuality,
      2,
    );

    expect(result.passed).toBe(false);
    // No ACP session should be created
    expect(mockClient.createSession).not.toHaveBeenCalled();
  });

  it("retries and returns passing result on second attempt", async () => {
    const mockClient = makeMockClient();
    const config = makeConfig({ maxRetries: 2 });

    vi.mocked(runQualityGate).mockResolvedValue(passingQuality);

    const result = await handleQualityFailure(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockClient as any,
      config,
      makeIssue(),
      "/tmp/worktrees/issue-42",
      failingQuality,
      0,
    );

    expect(result.passed).toBe(true);
    expect(mockClient.createSession).toHaveBeenCalledOnce();
    expect(mockClient.sendPrompt).toHaveBeenCalledOnce();
    expect(mockClient.endSession).toHaveBeenCalledOnce();
  });

  it("retries recursively until maxRetries is reached", async () => {
    const mockClient = makeMockClient();
    const config = makeConfig({ maxRetries: 3 });

    // All retries fail
    vi.mocked(runQualityGate).mockResolvedValue(failingQuality);

    const result = await handleQualityFailure(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockClient as any,
      config,
      makeIssue(),
      "/tmp/worktrees/issue-42",
      failingQuality,
      0,
    );

    expect(result.passed).toBe(false);
    // Should have created 3 sessions (retries 0→1, 1→2, 2→3=max)
    expect(mockClient.createSession).toHaveBeenCalledTimes(3);
    expect(runQualityGate).toHaveBeenCalledTimes(3);
  });

  it("ends ACP session even when sendPrompt fails during retry", async () => {
    const mockClient = makeMockClient();
    mockClient.sendPrompt.mockRejectedValue(new Error("retry failed"));
    const config = makeConfig({ maxRetries: 1 });

    await expect(
      handleQualityFailure(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockClient as any,
        config,
        makeIssue(),
        "/tmp/worktrees/issue-42",
        failingQuality,
        0,
      ),
    ).rejects.toThrow("retry failed");

    expect(mockClient.endSession).toHaveBeenCalledWith("session-abc");
  });
});

// --- buildQualityGateConfig ---

describe("buildQualityGateConfig", () => {
  it("returns DEFAULT_QUALITY_GATE_CONFIG when config.qualityGate is undefined", () => {
    const config = makeConfig();
    const result = buildQualityGateConfig(config);
    expect(result).toBe(DEFAULT_QUALITY_GATE_CONFIG);
  });

  it("returns the provided qualityGate when it exists on SprintConfig", () => {
    const customGate = {
      requireTests: false,
      requireLint: false,
      requireTypes: false,
      requireBuild: false,
      maxDiffLines: 1000,
      testCommand: ["npx", "vitest"],
      lintCommand: ["npx", "eslint"],
      typecheckCommand: ["npx", "tsc"],
      buildCommand: ["npx", "tsc", "-b"],
    };
    const config = makeConfig({ qualityGate: customGate });
    const result = buildQualityGateConfig(config);
    expect(result).toEqual(customGate);
  });

  it("DEFAULT_QUALITY_GATE_CONFIG has reasonable defaults", () => {
    expect(DEFAULT_QUALITY_GATE_CONFIG.requireTests).toBe(true);
    expect(DEFAULT_QUALITY_GATE_CONFIG.requireLint).toBe(true);
    expect(DEFAULT_QUALITY_GATE_CONFIG.requireTypes).toBe(true);
    expect(DEFAULT_QUALITY_GATE_CONFIG.requireBuild).toBe(true);
    expect(DEFAULT_QUALITY_GATE_CONFIG.maxDiffLines).toBe(300);
  });
});
