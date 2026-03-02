import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SprintRunner } from "../../src/runner.js";
import { SprintEventBus } from "../../src/events.js";
import type { SprintConfig } from "../../src/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// --- Mocks ---

vi.mock("../../src/acp/client.js", () => ({
  AcpClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../../src/ceremonies/planning.js", () => ({
  runSprintPlanning: vi.fn().mockResolvedValue({
    sprintNumber: 1,
    sprint_issues: [
      { number: 1, title: "Issue 1", ice_score: 8, depends_on: [], acceptanceCriteria: "AC", expectedFiles: ["src/a.ts"], points: 3 },
    ],
    execution_groups: [[1]],
    estimated_points: 3,
    rationale: "Test sprint",
  }),
}));

vi.mock("../../src/ceremonies/parallel-dispatcher.js", () => ({
  runParallelExecution: vi.fn().mockResolvedValue({
    results: [
      { issueNumber: 1, status: "completed", qualityGatePassed: true, qualityDetails: { passed: true, checks: [] }, branch: "feat/1-test", duration_ms: 10000, filesChanged: ["src/a.ts"], retryCount: 0, points: 3 },
    ],
    sprint: 1, parallelizationRatio: 1, avgWorktreeLifetime: 10000, mergeConflicts: 0,
  }),
}));

vi.mock("../../src/ceremonies/review.js", () => ({
  runSprintReview: vi.fn().mockResolvedValue({
    summary: "Good sprint", demoItems: ["Feature A"], velocityUpdate: "3 points", openItems: [],
  }),
}));

vi.mock("../../src/ceremonies/retro.js", () => ({
  runSprintRetro: vi.fn().mockResolvedValue({
    wentWell: ["Good"], wentBadly: ["Slow"], improvements: [], previousImprovementsChecked: true,
  }),
}));

vi.mock("../../src/documentation/sprint-log.js", () => ({ createSprintLog: vi.fn().mockReturnValue("docs/sprints/sprint-1-log.md") }));
vi.mock("../../src/documentation/velocity.js", () => ({ appendVelocity: vi.fn() }));
vi.mock("../../src/metrics.js", () => ({
  calculateSprintMetrics: vi.fn().mockReturnValue({
    planned: 1, completed: 1, failed: 0, pointsPlanned: 3, pointsCompleted: 3,
    velocity: 3, avgDuration: 10000, firstPassRate: 100, driftIncidents: 0,
  }),
}));
vi.mock("../../src/enforcement/drift-control.js", () => ({ holisticDriftCheck: vi.fn().mockResolvedValue({ totalFilesChanged: 1, plannedChanges: 1, unplannedChanges: [], driftPercentage: 0 }) }));
vi.mock("../../src/enforcement/escalation.js", () => ({ escalateToStakeholder: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/logger.js", () => {
  const noop = vi.fn();
  const childLogger = { info: noop, warn: noop, error: noop, debug: noop, child: vi.fn().mockReturnThis() };
  return { logger: { info: noop, warn: noop, error: noop, debug: noop, child: vi.fn().mockReturnValue(childLogger) }, createLogger: vi.fn().mockReturnValue(childLogger) };
});

// --- Helpers ---

function makeConfig(overrides: Partial<SprintConfig> = {}): SprintConfig {
  return {
    sprintNumber: 1, sprintPrefix: "Sprint", sprintSlug: "sprint",
    projectPath: os.tmpdir(), baseBranch: "main", worktreeBase: "../sprint-worktrees",
    branchPattern: "{prefix}/{sprint}/issue-{issue}", maxParallelSessions: 4,
    maxIssuesPerSprint: 8, maxDriftIncidents: 2, maxRetries: 2,
    enableChallenger: false, autoRevertDrift: false, backlogLabels: [],
    autoMerge: true, squashMerge: true, deleteBranchAfterMerge: true,
    sessionTimeoutMs: 600000, customInstructions: "", globalMcpServers: [],
    globalInstructions: [], phases: {}, ...overrides,
  };
}

// --- Tests ---

describe("sprint cycle integration", () => {
  let config: SprintConfig;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sprint-cycle-test-"));
    config = makeConfig({ projectPath: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fullCycle emits correct phase sequence", { timeout: 15000 }, async () => {
    const events = new SprintEventBus();
    const phaseChanges: string[] = [];
    events.onTyped("phase:change", (p) => phaseChanges.push(p.to));

    const runner = new SprintRunner(config, events);
    await runner.fullCycle();

    expect(phaseChanges).toEqual(["init", "plan", "execute", "review", "retro", "complete"]);
  });

  it("fullCycle emits sprint:start and sprint:complete", { timeout: 15000 }, async () => {
    const events = new SprintEventBus();
    const starts: { sprintNumber: number }[] = [];
    const completes: { sprintNumber: number }[] = [];
    events.onTyped("sprint:start", (p) => starts.push(p));
    events.onTyped("sprint:complete", (p) => completes.push(p));

    const runner = new SprintRunner(config, events);
    await runner.fullCycle();

    expect(starts).toHaveLength(1);
    expect(starts[0]!.sprintNumber).toBe(1);
    expect(completes).toHaveLength(1);
    expect(completes[0]!.sprintNumber).toBe(1);
  });

  it("fullCycle emits sprint:planned with issue list", { timeout: 15000 }, async () => {
    const events = new SprintEventBus();
    const planned: { issues: { number: number; title: string }[] }[] = [];
    events.onTyped("sprint:planned", (p) => planned.push(p));

    const runner = new SprintRunner(config, events);
    await runner.fullCycle();

    expect(planned).toHaveLength(1);
    expect(planned[0]!.issues).toEqual([{ number: 1, title: "Issue 1" }]);
  });

  it("fullCycle emits issue:start and issue:done for each issue", { timeout: 15000 }, async () => {
    const events = new SprintEventBus();
    const issueStarts: number[] = [];
    const issueDones: number[] = [];
    events.onTyped("issue:start", (p) => issueStarts.push(p.issue.number));
    events.onTyped("issue:done", (p) => issueDones.push(p.issueNumber));

    const runner = new SprintRunner(config, events);
    await runner.fullCycle();

    expect(issueStarts).toEqual([1]);
    expect(issueDones).toEqual([1]);
  });

  it("fullCycle on error emits sprint:error", { timeout: 15000 }, async () => {
    const { runSprintPlanning } = await import("../../src/ceremonies/planning.js");
    vi.mocked(runSprintPlanning).mockRejectedValueOnce(new Error("Planning exploded"));

    const events = new SprintEventBus();
    const errors: string[] = [];
    events.onTyped("sprint:error", (p) => errors.push(p.error));

    const runner = new SprintRunner(config, events);
    await runner.fullCycle();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe("Planning exploded");
  });
});
