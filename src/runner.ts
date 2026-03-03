import * as fs from "node:fs";
import { AcpClient } from "./acp/client.js";
import { resolveSessionConfig } from "./acp/session-config.js";
import { runSprintPlanning } from "./ceremonies/planning.js";
import { runParallelExecution } from "./ceremonies/parallel-dispatcher.js";
import { runSprintReview } from "./ceremonies/review.js";
import { runSprintRetro } from "./ceremonies/retro.js";
import { createSprintLog } from "./documentation/sprint-log.js";
import { appendVelocity } from "./documentation/velocity.js";
import { calculateSprintMetrics } from "./metrics.js";
import { getIssue } from "./github/issues.js";
import type { IssueCreationState } from "./github/issue-rate-limiter.js";
import { closeMilestone, getNextOpenMilestone } from "./github/milestones.js";
import { logger as defaultLogger } from "./logger.js";
import {
  STATE_VERSION,
  saveState,
  loadState,
  getStatePath,
  acquireLock,
  releaseLock,
} from "./state-manager.js";
import { SprintEventBus } from "./events.js";
import { attachSprintNotifications } from "./notifications/sprint-notifications.js";
import type {
  SprintConfig,
  SprintPlan,
  SprintResult,
  ReviewResult,
  RetroResult,
} from "./types.js";

export type SprintPhase =
  | "init"
  | "plan"
  | "execute"
  | "review"
  | "retro"
  | "complete"
  | "paused"
  | "stopped"
  | "failed";

/** Thrown when a sprint is aborted via stop(). */
export class SprintAbortedError extends Error {
  constructor() {
    super("Sprint stopped by user");
    this.name = "SprintAbortedError";
  }
}

export interface SprintState {
  version: string;
  sprintNumber: number;
  phase: SprintPhase;
  plan?: SprintPlan;
  result?: SprintResult;
  review?: ReviewResult;
  retro?: RetroResult;
  startedAt: Date;
  issuesCreatedCount?: number;
  error?: string;
}

// Re-export state persistence for consumers
export { saveState, loadState };

// --- Sprint Runner ---

export class SprintRunner {
  private state: SprintState;
  private client: AcpClient;
  private config: SprintConfig;
  private paused = false;
  private aborted = false;
  private hitlMode = false;
  private phaseBeforePause: SprintPhase | null = null;
  private readonly log;
  readonly events: SprintEventBus;

  constructor(config: SprintConfig, eventBus?: SprintEventBus) {
    this.config = config;
    this.events = eventBus ?? new SprintEventBus();
    this.client = new AcpClient({
      timeoutMs: config.sessionTimeoutMs,
      permissions: {
        autoApprove: config.autoApproveTools,
        allowPatterns: config.allowToolPatterns,
      },
      onStreamChunk: (sessionId, text) => {
        this.events.emitTyped("worker:output", { sessionId, text });
      },
    });
    this.state = {
      version: STATE_VERSION,
      sprintNumber: config.sprintNumber,
      phase: "init",
      startedAt: new Date(),
      issuesCreatedCount: 0,
    };
    attachSprintNotifications(this.events, this.config.ntfy);
    this.log = defaultLogger.child({
      component: "sprint-runner",
      sprint: config.sprintNumber,
    });
  }

  /** Get the ACP client (for direct use by dashboard). */
  getClient(): AcpClient {
    return this.client;
  }

  /** Load saved state from disk (if any). Updates the runner's state for dashboard display. */
  loadSavedState(): SprintState | null {
    const previous = this.tryLoadPreviousState();
    if (previous) {
      this.state = { ...previous, issuesCreatedCount: previous.issuesCreatedCount ?? 0 };
      this.log.info({ phase: previous.phase }, "Loaded saved sprint state");
    }
    return previous;
  }

  /** Run the full sprint cycle, resuming from a previous crash if state exists. */
  async fullCycle(): Promise<SprintState> {
    acquireLock(this.config);
    try {
      // Check for previous state to resume from
      const previous = this.tryLoadPreviousState();
      const resuming = previous && previous.phase !== "complete" && previous.plan;

      if (resuming && previous.plan) {
        this.state = { ...previous, error: undefined, issuesCreatedCount: previous.issuesCreatedCount ?? 0 };
        this.log.info({ resumeFrom: previous.phase }, "Resuming sprint from previous state");
        this.events.emitTyped("sprint:start", { sprintNumber: this.config.sprintNumber, resumed: true });
        this.events.emitTyped("log", { level: "info", message: `Resuming Sprint ${this.config.sprintNumber} from ${previous.phase} phase` });
        await this.client.connect();

        // Determine where to resume based on previous phase
        const plan = previous.plan;
        let result = previous.result;
        let review = previous.review;

        // Filter out already-completed issues before execution
        await this.filterCompletedIssues(plan);

        // Warn about issues missing acceptance criteria
        this.warnMissingAcceptanceCriteria(plan);

        // If we crashed during or after execute but before review
        if (!result || previous.phase === "execute") {
          if (this.hitlMode) {
            this.log.info("HITL mode — pausing before execution for stakeholder review");
            this.events.emitTyped("log", { level: "info", message: "⏸ HITL: Pausing before execution — review the plan and resume in dashboard to continue" });
            this.pause();
          }
          await this.checkInterrupted();
          const workerModel = (await resolveSessionConfig(this.config, "worker")).model;
          this.transition("execute", workerModel, "Worker Agent");
          result = await this.runExecute(plan);
        }

        if (!review || previous.phase === "review") {
          await this.checkInterrupted();
          const reviewerModel = (await resolveSessionConfig(this.config, "reviewer")).model;
          this.transition("review", reviewerModel, "Review Agent");
          review = await this.runReview(result);
        }

        if (!previous.retro || previous.phase === "retro") {
          await this.checkInterrupted();
          this.transition("retro", undefined, "Retro Agent");
          const retro = await this.runRetro(result, review);
          this.state.retro = retro;
        }

        this.transition("complete");
        await this.client.disconnect();
        this.persistState();
        this.events.emitTyped("sprint:complete", { sprintNumber: this.config.sprintNumber });
        return this.state;
      }

      // --- Fresh sprint ---

      // 1. init
      this.transition("init");
      this.events.emitTyped("sprint:start", { sprintNumber: this.config.sprintNumber });
      createSprintLog(this.config.sprintNumber, `${this.config.sprintPrefix} cycle started`, 0, undefined, this.config.sprintPrefix, this.config.sprintSlug);
      await this.client.connect();

      // 2. plan
      await this.checkInterrupted();
      const plannerModel = (await resolveSessionConfig(this.config, "planner")).model;
      this.transition("plan", plannerModel, "Planning Agent");
      const plan = await this.runPlan();

      // Broadcast planned issues so dashboard can update
      this.events.emitTyped("sprint:planned", {
        issues: plan.sprint_issues.map((i) => ({ number: i.number, title: i.title })),
      });

      // Filter out already-completed issues before execution
      await this.filterCompletedIssues(plan);

      // Warn about issues missing acceptance criteria
      this.warnMissingAcceptanceCriteria(plan);

      // 3. execute
      if (this.hitlMode) {
        this.log.info("HITL mode — pausing before execution for stakeholder review");
        this.events.emitTyped("log", { level: "info", message: "⏸ HITL: Pausing before execution — review the plan and resume in dashboard to continue" });
        this.pause();
      }
      await this.checkInterrupted();
      const workerModel = (await resolveSessionConfig(this.config, "worker")).model;
      this.transition("execute", workerModel, "Worker Agent");
      const result = await this.runExecute(plan);

      // 4. review
      await this.checkInterrupted();
      const reviewerModel = (await resolveSessionConfig(this.config, "reviewer")).model;
      this.transition("review", reviewerModel, "Review Agent");
      const review = await this.runReview(result);

      // 5. retro
      await this.checkInterrupted();
      this.transition("retro", undefined, "Retro Agent");
      const retro = await this.runRetro(result, review);

      // 6. complete
      this.state.retro = retro;
      this.transition("complete");
      await this.client.disconnect();
      this.persistState();
      this.events.emitTyped("sprint:complete", { sprintNumber: this.config.sprintNumber });

      return this.state;
    } catch (err: unknown) {
      const isStopped = err instanceof SprintAbortedError;
      const message = err instanceof Error ? err.message : String(err);
      this.state.phase = isStopped ? "stopped" : "failed";
      this.state.error = message;

      if (isStopped) {
        this.log.info("Sprint stopped by user");
        this.events.emitTyped("sprint:stopped", { sprintNumber: this.config.sprintNumber });
      } else {
        this.log.error({ error: message }, "Sprint cycle failed");
        this.events.emitTyped("sprint:error", { error: message });
      }

      try {
        await this.client.disconnect();
      } catch {
        // best-effort disconnect
      }

      this.persistState();
      return this.state;
    } finally {
      releaseLock(this.config);
    }
  }

  /**
   * Run sprints in a continuous loop, auto-detecting the next sprint
   * from GitHub milestones. Closes each milestone on completion and
   * moves to the next open one. Stops when no open milestone is found
   * or maxSprints is reached. maxSprints=0 means infinite.
   * maxSprints can be a number or a getter function for runtime updates.
   */
  static async sprintLoop(
    configBuilder: (sprintNumber: number) => SprintConfig,
    eventBus?: SprintEventBus,
    maxSprints: number | (() => number) = 0,
    onRunner?: (runner: SprintRunner) => void,
  ): Promise<SprintState[]> {
    const log = defaultLogger.child({ component: "sprint-loop" });
    const results: SprintState[] = [];
    const bus = eventBus ?? new SprintEventBus();
    const getLimit = typeof maxSprints === "function" ? maxSprints : () => maxSprints;

    while (true) {
      const limit = getLimit();
      if (limit > 0 && results.length >= limit) {
        log.info({ completed: results.length, limit }, "Sprint limit reached — pausing");
        bus.emitTyped("log", { level: "info", message: `Sprint limit reached (${results.length}/${limit}) — pausing` });
        break;
      }
      // Use configBuilder to get prefix for milestone detection
      const sampleConfig = configBuilder(1);
      let next;
      try {
        next = await getNextOpenMilestone(sampleConfig.sprintPrefix);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ error: msg }, "Failed to detect next sprint milestone — check that a milestone like 'Sprint N' exists");
        bus.emitTyped("log", { level: "error", message: `Milestone detection failed: ${msg}` });
        break;
      }
      if (!next) {
        log.info("No open sprint milestones found — loop complete");
        bus.emitTyped("log", { level: "info", message: "No open sprint milestones — loop complete" });
        break;
      }

      const { sprintNumber, milestone } = next;
      log.info({ sprintNumber, milestone: milestone.title }, "Starting sprint");
      bus.emitTyped("log", { level: "info", message: `Starting ${milestone.title}` });

      const config = configBuilder(sprintNumber);
      const runner = new SprintRunner(config, bus);
      onRunner?.(runner);
      const state = await runner.fullCycle();
      results.push(state);

      if (state.phase === "complete") {
        try {
          await closeMilestone(milestone.title);
          log.info({ milestone: milestone.title }, "Milestone closed");
        } catch (err: unknown) {
          log.warn({ err, milestone: milestone.title }, "Failed to close milestone");
        }
      } else {
        log.warn({ phase: state.phase }, "Sprint did not complete — stopping loop");
        bus.emitTyped("log", { level: "warn", message: `Sprint ${sprintNumber} failed — loop stopped` });
        break;
      }
    }

    return results;
  }
  /** Run the sprint planning phase */
  async runPlan(): Promise<SprintPlan> {
    this.log.info("Running sprint planning");
    const plan = await runSprintPlanning(this.client, this.config, this.events);
    this.state.plan = plan;
    this.persistState();
    this.log.info(
      { issues: plan.sprint_issues.length, points: plan.estimated_points },
      "Sprint planning complete",
    );
    return plan;
  }

  /** Run the execution phase */
  async runExecute(plan: SprintPlan): Promise<SprintResult> {
    this.log.info("Running parallel execution");

    const workerModel = (await resolveSessionConfig(this.config, "worker")).model;

    // Emit issue:start for all planned issues
    for (const issue of plan.sprint_issues) {
      this.events.emitTyped("issue:start", { issue, model: workerModel });
    }

    const result = await runParallelExecution(
      this.client,
      this.config,
      plan,
      this.events,
    );
    this.state.result = result;

    // Emit issue:done / issue:fail for each result
    for (const r of result.results) {
      if (r.status === "completed") {
        this.events.emitTyped("issue:done", {
          issueNumber: r.issueNumber,
          quality: r.qualityDetails,
          duration_ms: r.duration_ms,
        });
      } else {
        this.events.emitTyped("issue:fail", {
          issueNumber: r.issueNumber,
          reason: (r.qualityDetails?.checks ?? []).filter(c => !c.passed).map(c => c.name).join(", ") || "execution failed",
          duration_ms: r.duration_ms,
        });
      }
    }

    this.persistState();
    this.log.info(
      {
        completed: result.results.filter((r) => r.status === "completed").length,
        failed: result.results.filter((r) => r.status === "failed").length,
      },
      "Execution complete",
    );
    return result;
  }

  /** Run the sprint review phase */
  async runReview(result: SprintResult): Promise<ReviewResult> {
    this.log.info("Running sprint review");
    const metrics = calculateSprintMetrics(result);
    const review = await runSprintReview(this.client, this.config, result, this.events);
    this.state.review = review;

    // Append velocity
    appendVelocity({
      sprint: this.config.sprintNumber,
      date: new Date().toISOString().slice(0, 10),
      goal: this.state.plan?.rationale ?? "",
      planned: metrics.planned,
      done: metrics.completed,
      carry: metrics.failed,
      hours: Math.round(metrics.avgDuration * metrics.planned / 3_600_000),
      issuesPerHr:
        metrics.avgDuration > 0
          ? Math.round((metrics.completed / (metrics.avgDuration * metrics.planned / 3_600_000)) * 100) / 100
          : 0,
      notes: review.summary,
    });

    this.persistState();
    this.log.info("Sprint review complete");
    return review;
  }

  /** Run the retrospective phase */
  async runRetro(result: SprintResult, review: ReviewResult): Promise<RetroResult> {
    this.log.info("Running sprint retro");
    const retro = await runSprintRetro(
      this.client,
      this.config,
      result,
      review,
      this.events,
      this.state as IssueCreationState,
    );
    this.state.retro = retro;
    this.persistState();
    this.log.info(
      { improvements: retro.improvements.length },
      "Sprint retro complete",
    );
    return retro;
  }

  /** Pause the sprint runner */
  pause(): void {
    if (this.state.phase !== "paused" && this.state.phase !== "failed" && this.state.phase !== "complete") {
      this.phaseBeforePause = this.state.phase;
      this.paused = true;
      this.state.phase = "paused";
      this.log.info({ previousPhase: this.phaseBeforePause }, "Sprint paused");
      this.events.emitTyped("sprint:paused", {});
      this.persistState();
    }
  }

  /** Resume the sprint runner */
  resume(): void {
    if (this.paused && this.phaseBeforePause) {
      this.paused = false;
      this.state.phase = this.phaseBeforePause;
      this.phaseBeforePause = null;
      this.log.info({ phase: this.state.phase }, "Sprint resumed");
      this.events.emitTyped("sprint:resumed", { phase: this.state.phase });
      this.persistState();
    }
  }

  /** Stop the sprint — aborts execution, disconnects ACP, releases lock. */
  stop(): void {
    if (this.aborted) return;
    this.aborted = true;
    // Unblock the pause loop so checkInterrupted() can throw
    this.paused = false;
    this.phaseBeforePause = null;
    this.log.info("Sprint stop requested — aborting");
    this.events.emitTyped("log", { level: "warn", message: "Sprint stopped by user" });
  }

  /** Get current sprint state */
  getState(): SprintState {
    return { ...this.state };
  }

  /** Enable or disable HITL (Human-in-the-Loop) mode */
  setHitlMode(enabled: boolean): void {
    this.hitlMode = enabled;
    this.log.info({ hitlMode: enabled }, "HITL mode changed");
  }

  // --- Private helpers ---

  private transition(phase: SprintPhase, model?: string, agent?: string): void {
    const previous = this.state.phase;
    this.state.phase = phase;
    this.log.info({ from: previous, to: phase, model, agent }, "Phase transition");
    this.events.emitTyped("phase:change", { from: previous, to: phase, model, agent });
  }

  /** Filter out issues that already have the status:done label. */
  private async filterCompletedIssues(plan: SprintPlan): Promise<void> {
    if (!plan.sprint_issues?.length) return;
    const activeIssues = [];
    for (const issue of plan.sprint_issues) {
      try {
        const details = await getIssue(issue.number);
        const labels = details.labels?.map((l) => l.name) ?? [];
        if (labels.includes("status:done")) {
          this.log.warn({ issue: issue.number, title: issue.title }, "Skipping already-completed issue");
        } else {
          activeIssues.push(issue);
        }
      } catch (err: unknown) {
        // If we can't fetch the issue, keep it in the plan to be safe
        this.log.warn({ issue: issue.number, err }, "Could not check issue status, keeping in plan");
        activeIssues.push(issue);
      }
    }
    if (activeIssues.length < plan.sprint_issues.length) {
      this.log.info(
        { removed: plan.sprint_issues.length - activeIssues.length, remaining: activeIssues.length },
        "Filtered completed issues from sprint plan",
      );
      plan.sprint_issues = activeIssues;
    }
  }

  /** Warn about issues that have empty acceptance criteria. */
  private warnMissingAcceptanceCriteria(plan: SprintPlan): void {
    for (const issue of plan.sprint_issues) {
      if (!issue.acceptanceCriteria?.trim()) {
        this.log.warn(
          { issue: issue.number, title: issue.title },
          "Issue has no acceptance criteria — worker may produce low-quality output",
        );
        this.events.emitTyped("log", {
          level: "warn",
          message: `⚠️ Issue #${issue.number} has no acceptance criteria`,
        });
      }
    }
  }

  /** Block while paused; throw if aborted. Called at every phase boundary. */
  private async checkInterrupted(): Promise<void> {
    if (this.aborted) throw new SprintAbortedError();
    while (this.paused) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (this.aborted) throw new SprintAbortedError();
    }
  }

  private get stateFilePath(): string {
    return getStatePath(this.config);
  }

  private persistState(): void {
    try {
      saveState(this.state, this.stateFilePath);
    } catch (firstErr: unknown) {
      this.log.warn({ err: firstErr }, "State persistence failed — retrying once");
      try {
        saveState(this.state, this.stateFilePath);
      } catch (retryErr: unknown) {
        throw new Error(`State persistence failed after retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
      }
    }
  }

  /** Try to load a previous state for this sprint. Returns null if none exists. */
  private tryLoadPreviousState(): SprintState | null {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        return loadState(this.stateFilePath);
      }
    } catch (err: unknown) {
      this.log.warn({ err }, "Failed to load previous state — starting fresh");
    }
    return null;
  }
}
