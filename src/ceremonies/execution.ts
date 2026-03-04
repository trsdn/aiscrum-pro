import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AcpClient } from "../acp/client.js";
import { ACP_MODES } from "../acp/client.js";
import { resolveSessionConfig } from "../acp/session-config.js";
import type {
  SprintConfig,
  SprintIssue,
  IssueResult,
  QualityResult,
  HuddleEntry,
  CodeReviewResult,
} from "../types.js";
import { createWorktree, removeWorktree } from "../git/worktree.js";
import { runQualityGate } from "../enforcement/quality-gate.js";
import { runCodeReview } from "../enforcement/code-review.js";
import { formatHuddleComment, formatSprintLogEntry } from "../documentation/huddle.js";
import type { ZeroChangeDiagnostic, HuddleEntryWithDiag } from "../documentation/huddle.js";
import { appendToSprintLog } from "../documentation/sprint-log.js";
import { addComment } from "../github/issues.js";
import { setStatusLabel } from "../github/labels.js";
import { getChangedFiles } from "../git/diff-analysis.js";
import { getPRStats } from "../git/merge.js";
import { substitutePrompt, extractJson, sanitizePromptInput, parseWithRetry } from "./helpers.js";
import { logger, appendErrorLog } from "../logger.js";
import { AcceptanceCriteriaSchema } from "../types/schemas.js";
import type { SprintEventBus } from "../events.js";
import { buildBranch, buildQualityGateConfig } from "./quality-retry.js";
import { sessionController } from "../dashboard/session-control.js";
import type { Logger } from "pino";

// Re-export for backward compatibility
export { handleQualityFailure } from "./quality-retry.js";

/** Shared context threaded through execution sub-phases. */
interface ExecutionContext {
  client: AcpClient;
  config: SprintConfig;
  issue: SprintIssue;
  eventBus?: SprintEventBus;
  log: Logger;
  branch: string;
  worktreePath: string;
  progress: (step: string) => void;
}

// ---------------------------------------------------------------------------
// Sub-phase: Plan
// ---------------------------------------------------------------------------

/** Create ACP session in Plan mode, generate implementation plan, tear down session. */
async function planPhase(ctx: ExecutionContext): Promise<string> {
  const { client, config, issue, eventBus, log, worktreePath, progress } = ctx;
  const plannerConfig = await resolveSessionConfig(config, "planner");
  const promptVars = buildPromptVars(ctx);

  let implementationPlan = "";

  const { sessionId } = await client.createSession({
    cwd: worktreePath,
    mcpServers: plannerConfig.mcpServers,
  });
  eventBus?.emitTyped("session:start", {
    sessionId,
    role: "planner",
    issueNumber: issue.number,
    model: plannerConfig.model,
  });

  try {
    await client.setMode(sessionId, ACP_MODES.PLAN);
    if (plannerConfig.model) {
      await client.setModel(sessionId, plannerConfig.model);
    }
    log.info("planner session started in Plan mode");
    progress("planning implementation");

    const planTemplatePath = path.join(
      config.projectPath,
      ".aiscrum",
      "roles",
      "planner",
      "prompts",
      "item-planner.md",
    );
    const planTemplate = await fs.readFile(planTemplatePath, "utf-8");
    let planPrompt = substitutePrompt(planTemplate, promptVars);

    if (plannerConfig.instructions) {
      planPrompt = plannerConfig.instructions + "\n\n" + planPrompt;
    }

    const planResult = await client.sendPrompt(sessionId, planPrompt, config.sessionTimeoutMs);
    implementationPlan = planResult.response;

    try {
      const planJson = extractJson<{
        summary: string;
        steps: Array<{ file?: string; action?: string }>;
      }>(implementationPlan);
      log.info(
        { summary: planJson.summary, stepCount: planJson.steps?.length ?? 0 },
        "implementation plan created",
      );
      // Extract files from the structured plan and merge into expectedFiles.
      // The item planner has read the codebase — its file predictions are more accurate
      // than the sprint planner's guesses.
      if (planJson.steps) {
        const planFiles = planJson.steps
          .map((s) => s.file)
          .filter((f): f is string => typeof f === "string" && f.length > 0);
        if (planFiles.length > 0) {
          const existing = new Set(issue.expectedFiles);
          for (const f of planFiles) {
            existing.add(f);
          }
          issue.expectedFiles = [...existing];
          log.info(
            { expectedFiles: issue.expectedFiles },
            "expectedFiles updated from implementation plan",
          );
        }
      }
    } catch {
      log.warn(
        { issue: issue.number, responseLength: implementationPlan.length },
        "implementation plan JSON extraction failed — proceeding with unstructured plan",
      );
    }

    await addComment(
      issue.number,
      `### 📋 Implementation Plan — #${issue.number}\n\n${implementationPlan}`,
    );
    log.info("plan posted to issue");
  } catch (err: unknown) {
    log.warn({ err }, "plan mode failed — proceeding with direct execution");
  } finally {
    eventBus?.emitTyped("session:end", { sessionId, outcome: "completed" });
    await client.endSession(sessionId);
  }

  return implementationPlan;
}

// ---------------------------------------------------------------------------

/** Create ACP session for Test-Engineer to write failing tests based on the plan. */
async function tddPhase(ctx: ExecutionContext, implementationPlan: string): Promise<void> {
  const { client, config, issue, eventBus, log, worktreePath, progress } = ctx;
  const testConfig = await resolveSessionConfig(config, "test-engineer");
  const promptVars: Record<string, string> = {
    ...buildPromptVars(ctx),
    IMPLEMENTATION_PLAN: implementationPlan,
  };

  const { sessionId } = await client.createSession({
    cwd: worktreePath,
    mcpServers: testConfig.mcpServers,
  });
  eventBus?.emitTyped("session:start", {
    sessionId,
    role: "test-engineer",
    issueNumber: issue.number,
    model: testConfig.model,
  });

  try {
    await client.setMode(sessionId, ACP_MODES.AGENT);
    if (testConfig.model) {
      await client.setModel(sessionId, testConfig.model);
    }
    log.info("test-engineer session started");
    progress("writing tests (TDD)");

    const tddTemplatePath = path.join(
      config.projectPath,
      ".aiscrum",
      "roles",
      "test-engineer",
      "prompts",
      "tdd.md",
    );
    const tddTemplate = await fs.readFile(tddTemplatePath, "utf-8");
    let tddPrompt = substitutePrompt(tddTemplate, promptVars);

    if (testConfig.instructions) {
      tddPrompt = testConfig.instructions + "\n\n" + tddPrompt;
    }

    await client.sendPrompt(sessionId, tddPrompt, config.sessionTimeoutMs);

    await addComment(
      issue.number,
      `### 🧪 TDD — Tests Written (pre-implementation)\n\nTest-Engineer wrote tests based on the implementation plan. Developer will now implement to make them pass.`,
    ).catch((err) => log.warn({ err: String(err) }, "failed to post TDD comment"));

    log.info("TDD tests written");
  } finally {
    eventBus?.emitTyped("session:end", { sessionId, outcome: "completed" });
    await client.endSession(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Sub-phase: Implement
// ---------------------------------------------------------------------------

interface ImplementResult {
  acpOutputLines: string[];
  sessionId: string;
}

/** Create ACP session in Agent mode, implement the plan. Session stays open for QG retries. */
async function implementPhase(
  ctx: ExecutionContext,
  implementationPlan: string,
): Promise<ImplementResult> {
  const { client, config, issue, eventBus, log, worktreePath, progress } = ctx;
  const workerConfig = await resolveSessionConfig(config, "worker");
  const promptVars = buildPromptVars(ctx);

  const { sessionId } = await client.createSession({
    cwd: worktreePath,
    mcpServers: workerConfig.mcpServers,
  });
  eventBus?.emitTyped("session:start", {
    sessionId,
    role: "developer",
    issueNumber: issue.number,
    model: workerConfig.model,
  });

  let acpOutputLines: string[] = [];
  try {
    await client.setMode(sessionId, ACP_MODES.AGENT);
    if (workerConfig.model) {
      await client.setModel(sessionId, workerConfig.model);
    }
    log.info("developer session started in Agent mode");
    progress("implementing");

    const workerTemplatePath = path.join(
      config.projectPath,
      ".aiscrum",
      "roles",
      "general",
      "prompts",
      "worker.md",
    );
    const workerTemplate = await fs.readFile(workerTemplatePath, "utf-8");
    let workerPrompt = substitutePrompt(workerTemplate, promptVars);

    if (workerConfig.instructions) {
      workerPrompt = workerConfig.instructions + "\n\n" + workerPrompt;
    }

    if (implementationPlan) {
      workerPrompt += `\n\n## Implementation Plan (follow this)\n\n${implementationPlan}`;
    }

    await client.sendPrompt(sessionId, workerPrompt, config.sessionTimeoutMs);

    // Process queued interactive messages from dashboard
    while (sessionController.hasPending(sessionId) && !sessionController.shouldStop(sessionId)) {
      const messages = sessionController.drain(sessionId);
      for (const msg of messages) {
        if (msg.type === "user-message" && msg.content) {
          log.info({ sessionId }, "sending queued user message to session");
          eventBus?.emitTyped("worker:output", {
            sessionId,
            text: `\n\n---\n**User message:** ${msg.content}\n---\n\n`,
          });
          await client.sendPrompt(sessionId, msg.content, config.sessionTimeoutMs);
        }
      }
    }

    if (sessionController.shouldStop(sessionId)) {
      log.warn({ sessionId, issue: issue.number }, "session stopped by user");
      eventBus?.emitTyped("worker:output", { sessionId, text: "\n\n⏹ Session stopped by user.\n" });
    }
    sessionController.cleanup(sessionId);
  } catch (err: unknown) {
    // On error, close session before re-throwing
    acpOutputLines = client.getSessionOutput(sessionId, 50);
    eventBus?.emitTyped("session:end", { sessionId, outcome: "failed" });
    await client.endSession(sessionId);
    throw err;
  }

  acpOutputLines = client.getSessionOutput(sessionId, 50);
  return { acpOutputLines, sessionId };
}

// ---------------------------------------------------------------------------
// Sub-phase: Acceptance criteria review
// ---------------------------------------------------------------------------

const execFile = promisify(execFileCb);

// AcceptanceCriteriaResult type is derived from AcceptanceCriteriaSchema in schemas.ts
type AcceptanceCriteriaResult = import("zod").infer<typeof AcceptanceCriteriaSchema>;

/** Run acceptance criteria review via a fresh ACP reviewer session. */
async function acceptanceCriteriaReview(
  ctx: ExecutionContext,
  qualityResult: QualityResult,
): Promise<AcceptanceCriteriaResult> {
  const { client, config, issue, eventBus, log, worktreePath, branch } = ctx;

  const reviewerConfig = await resolveSessionConfig(config, "reviewer");

  // Get diff
  let diff: string;
  try {
    const { stdout } = await execFile("git", ["diff", `${config.baseBranch}...${branch}`], {
      cwd: worktreePath,
    });
    diff = stdout;
  } catch {
    diff = "(diff unavailable)";
  }

  // Load prompt template
  const templatePath = path.join(
    config.projectPath,
    ".aiscrum",
    "roles",
    "quality-reviewer",
    "prompts",
    "acceptance-review.md",
  );
  const template = await fs.readFile(templatePath, "utf-8");

  const promptVars: Record<string, string> = {
    ISSUE_NUMBER: String(issue.number),
    ISSUE_TITLE: issue.title,
    ACCEPTANCE_CRITERIA: issue.acceptanceCriteria,
    DIFF: diff,
    TEST_OUTPUT: "Tests passed",
    QG_RESULT: JSON.stringify(qualityResult.checks),
  };

  const prompt = substitutePrompt(template, promptVars);

  const { sessionId } = await client.createSession({
    cwd: worktreePath,
    mcpServers: reviewerConfig.mcpServers,
  });
  eventBus?.emitTyped("session:start", {
    sessionId,
    role: "quality-reviewer",
    issueNumber: issue.number,
    model: reviewerConfig.model,
  });

  let acOutcome: "approved" | "changes_requested" | "failed" = "failed";

  try {
    if (reviewerConfig.model) {
      await client.setModel(sessionId, reviewerConfig.model);
    }

    const result = await client.sendPrompt(sessionId, prompt, config.sessionTimeoutMs);
    const acResult = await parseWithRetry(
      AcceptanceCriteriaSchema,
      result.response,
      async (hint) => {
        const retry = await client.sendPrompt(sessionId, hint, config.sessionTimeoutMs);
        return retry.response;
      },
    );

    // Post results as issue comment
    const status = acResult.approved ? "✅ Passed" : "❌ Failed";
    const criteriaLines = acResult.criteria
      .map(
        (c) =>
          `- ${c.passed ? "✅" : "❌"} ${c.criterion}${c.passed ? (c.evidence ? `: ${c.evidence}` : "") : c.concern ? `: ${c.concern}` : ""}`,
      )
      .join("\n");
    const comment = `### 📋 Acceptance Criteria Review — ${status}\n\n${criteriaLines}${acResult.summary ? `\n\n${acResult.summary}` : ""}`;
    await addComment(issue.number, comment).catch((err) =>
      log.warn({ err: String(err) }, "failed to post AC review comment"),
    );

    log.info({ approved: acResult.approved }, "acceptance criteria review completed");
    acOutcome = acResult.approved ? "approved" : "changes_requested";
    return acResult;
  } finally {
    eventBus?.emitTyped("session:end", { sessionId, outcome: acOutcome });
    await client.endSession(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Sub-phase: Quality gate + code review
// ---------------------------------------------------------------------------

interface ReviewOutcome {
  qualityResult: QualityResult;
  codeReview?: CodeReviewResult;
  retryCount: number;
}

/** Run quality gate and code review. Sends QG retry feedback to the developer session. */
async function qualityAndReviewPhase(
  ctx: ExecutionContext,
  devSessionId: string,
): Promise<ReviewOutcome> {
  const { client, config, issue, log, worktreePath, branch, progress } = ctx;

  progress("quality gate");
  const gateConfig = buildQualityGateConfig(config);
  gateConfig.expectedFiles = issue.expectedFiles;
  let qualityResult = await runQualityGate(gateConfig, worktreePath, branch, config.baseBranch);

  // Post quality gate results as issue comment
  const qgChecks = qualityResult.checks
    .map((c) => `${c.passed ? "✅" : "❌"} **${c.name}**: ${c.detail}`)
    .join("\n");
  const qgStatus = qualityResult.passed ? "✅ Passed" : "❌ Failed";
  await addComment(issue.number, `### 🔍 Quality Gate — ${qgStatus}\n\n${qgChecks}`).catch((err) =>
    log.warn({ err: String(err) }, "failed to post quality gate comment"),
  );

  let retryCount = 0;
  if (!qualityResult.passed) {
    // Retry using the SAME developer session — it has full context
    qualityResult = await handleQualityRetryInSession(
      client,
      config,
      issue,
      worktreePath,
      qualityResult,
      devSessionId,
    );
    retryCount = qualityResult.passed ? 0 : config.maxRetries;
  }

  let codeReview: CodeReviewResult | undefined;
  if (qualityResult.passed) {
    try {
      progress("code review");
      codeReview = await runCodeReview(client, config, issue, branch, worktreePath, ctx.eventBus);

      if (!codeReview.approved) {
        progress("review rejected — fixing");
        const fixResult = await attemptCodeReviewFix(ctx, codeReview, devSessionId);
        qualityResult = fixResult.qualityResult;
        codeReview = fixResult.codeReview;
      }
    } catch (err: unknown) {
      log.warn(
        { err, issue: issue.number },
        "code review failed — proceeding without review (tracked in metrics)",
      );
      codeReview = {
        approved: false,
        feedback: "Code review skipped due to error",
        issues: ["review-skipped"],
      };
    }
  }

  // Acceptance criteria review — after code review passes
  if (qualityResult.passed) {
    try {
      progress("acceptance review");
      const acReview = await acceptanceCriteriaReview(ctx, qualityResult);
      if (!acReview.approved) {
        progress("acceptance failed — fixing");
        const feedback = acReview.reasoning || acReview.summary || "Acceptance criteria not met";
        await client.sendPrompt(
          devSessionId,
          `## Acceptance Criteria Review Failed\n\n${feedback}\n\nPlease fix the issues and ensure all acceptance criteria are met.`,
          config.sessionTimeoutMs,
        );
        // Re-run quality gate after fix
        qualityResult = await runQualityGate(gateConfig, worktreePath, branch, config.baseBranch);
        if (!qualityResult.passed) {
          retryCount++;
        }
      }
    } catch (err) {
      log.warn(
        { err, issue: issue.number },
        "acceptance criteria review failed — proceeding without (tracked in metrics)",
      );
    }
  }

  return { qualityResult, codeReview, retryCount };
}

/**
 * Retry quality gate failures by sending feedback to the existing developer session.
 * The developer retains full context from implementation.
 */
async function handleQualityRetryInSession(
  client: AcpClient,
  config: SprintConfig,
  issue: SprintIssue,
  worktreePath: string,
  qualityResult: QualityResult,
  devSessionId: string,
): Promise<QualityResult> {
  const log = logger.child({ ceremony: "execution", issue: issue.number });

  for (let retry = 0; retry < config.maxRetries; retry++) {
    const failedChecks = qualityResult.checks
      .filter((c) => !c.passed)
      .map((c) => `- ${c.name}: ${c.detail}`)
      .join("\n");

    const feedbackPrompt = [
      `## Quality Gate Failed — Retry ${retry + 1}/${config.maxRetries}`,
      "",
      `The quality gate for issue #${issue.number} failed with the following checks:`,
      "",
      failedChecks,
      "",
      "Please fix the failing checks. You have the full context of your implementation.",
    ].join("\n");

    log.info({ retryCount: retry + 1 }, "retrying quality gate in same developer session");

    await client.sendPrompt(devSessionId, feedbackPrompt, config.sessionTimeoutMs);

    const branch = buildBranch(config, issue.number);
    const gateConfig = buildQualityGateConfig(config);
    gateConfig.expectedFiles = issue.expectedFiles;
    qualityResult = await runQualityGate(gateConfig, worktreePath, branch, config.baseBranch);

    if (qualityResult.passed) {
      return qualityResult;
    }
  }

  return qualityResult;
}

/** Attempt to fix code review issues using the existing developer session. */
async function attemptCodeReviewFix(
  ctx: ExecutionContext,
  codeReview: CodeReviewResult,
  devSessionId: string,
): Promise<{ qualityResult: QualityResult; codeReview?: CodeReviewResult }> {
  const { client, config, issue, log, worktreePath, branch, progress } = ctx;

  log.warn("code review rejected — attempting fix in same session");
  progress("developer fixing review issues");

  const fixPrompt = [
    "The automated code review found issues with your implementation.",
    "Please address the following feedback:\n",
    codeReview.feedback,
    "\nFix the issues and ensure tests still pass.",
  ].join("\n");
  await client.sendPrompt(devSessionId, fixPrompt, config.sessionTimeoutMs);

  const rerunGateConfig = buildQualityGateConfig(config);
  rerunGateConfig.expectedFiles = issue.expectedFiles;
  const newQuality = await runQualityGate(rerunGateConfig, worktreePath, branch, config.baseBranch);

  let newReview: CodeReviewResult | undefined = codeReview;
  if (newQuality.passed) {
    progress("re-reviewing code");
    newReview = await runCodeReview(client, config, issue, branch, worktreePath, ctx.eventBus);
    log.info({ approved: newReview.approved }, "code review re-run after fix");
  }

  return { qualityResult: newQuality, codeReview: newReview };
}

// ---------------------------------------------------------------------------
// Sub-phase: Cleanup (worktree, huddle, labels)
// ---------------------------------------------------------------------------

interface CleanupInput {
  status: "completed" | "failed";
  qualityResult: QualityResult;
  codeReview?: CodeReviewResult;
  retryCount: number;
  filesChanged: string[];
  errorMessage?: string;
  startTime: number;
  acpOutputLines: string[];
  timedOut: boolean;
}

/** Remove worktree, post huddle, set final labels. */
async function cleanupPhase(ctx: ExecutionContext, input: CleanupInput): Promise<void> {
  const { config, issue, log, worktreePath, branch } = ctx;
  const duration_ms = Date.now() - input.startTime;

  // Remove worktree (keeps branch for PR)
  let cleanupWarning: string | undefined;
  try {
    await removeWorktree(worktreePath);
    log.info("worktree removed");
  } catch (err: unknown) {
    cleanupWarning = `⚠️ Orphaned worktree requires manual cleanup: \`${worktreePath}\``;
    log.error(
      { err, worktreePath },
      "failed to remove worktree — orphaned worktree may need manual cleanup",
    );
  }

  // Enrich with PR stats
  let prStats: HuddleEntry["prStats"];
  try {
    const stats = await getPRStats(branch);
    if (stats) {
      prStats = stats;
      if (input.filesChanged.length === 0 && stats.changedFiles > 0) {
        log.info(
          { prNumber: stats.prNumber, changedFiles: stats.changedFiles },
          "PR has files — overriding local diff",
        );
        input.filesChanged = [`(${stats.changedFiles} files via PR #${stats.prNumber})`];

        // If the only failure reason was zero file changes, recover the status
        const zeroChangeOnly =
          input.status === "failed" &&
          input.qualityResult.checks.some((c) => c.name === "files-changed" && !c.passed) &&
          input.qualityResult.checks.filter((c) => !c.passed).length === 1;
        if (zeroChangeOnly) {
          log.info({ issue: issue.number }, "Recovering status — PR has actual file changes");
          input.status = "completed";
          input.qualityResult = {
            passed: true,
            checks: input.qualityResult.checks.map((c) =>
              c.name === "files-changed"
                ? { ...c, passed: true, detail: `${stats.changedFiles} files via PR` }
                : c,
            ),
          };
        }
      }
    }
  } catch {
    // Non-critical — proceed with local diff data
  }

  // Build zero-change diagnostic if applicable
  let zeroChangeDiagnostic: ZeroChangeDiagnostic | undefined;
  if (input.filesChanged.length === 0 && input.qualityResult.passed === false) {
    // Classify the outcome
    const hasError =
      input.errorMessage ||
      input.timedOut ||
      input.acpOutputLines.some((line) =>
        /Error:|FAIL|Exception|TypeError|ReferenceError/.test(line),
      );

    zeroChangeDiagnostic = {
      lastOutputLines: input.acpOutputLines,
      timedOut: input.timedOut,
      workerOutcome: hasError ? "worker-error" : "task-not-applicable",
    };
  }

  // Huddle — format comment, post to issue, append to sprint log
  const huddleEntry: HuddleEntryWithDiag = {
    issueNumber: issue.number,
    issueTitle: issue.title,
    status: input.status,
    qualityResult: input.qualityResult,
    codeReview: input.codeReview,
    duration_ms,
    filesChanged: input.filesChanged,
    timestamp: new Date(),
    cleanupWarning,
    errorMessage: input.errorMessage,
    prStats,
    retryCount: input.retryCount,
    zeroChangeDiagnostic,
  };

  const comment = formatHuddleComment(huddleEntry);
  try {
    await addComment(issue.number, comment);
  } catch (err: unknown) {
    log.warn({ err, issueNumber: issue.number }, "failed to post huddle comment — non-critical");
  }

  const logEntry = formatSprintLogEntry(huddleEntry);
  appendToSprintLog(config.sprintNumber, logEntry, undefined, config.sprintSlug);

  // Set final label
  const finalLabel = input.status === "completed" ? "status:done" : "status:blocked";
  try {
    await setStatusLabel(issue.number, finalLabel);
    if (finalLabel === "status:blocked") {
      const blockReason =
        input.errorMessage ??
        input.qualityResult?.checks
          .filter((c) => !c.passed)
          .map((c) => `${c.name}: ${c.detail}`)
          .join("; ") ??
        "Unknown reason";
      await addComment(issue.number, `**Block reason:** ${blockReason}`).catch((err) =>
        log.warn({ err: String(err), issue: issue.number }, "failed to post block reason comment"),
      );
    }
    log.info({ status: input.status, finalLabel }, "final status set");
  } catch (err: unknown) {
    log.warn(
      { err, issueNumber: issue.number, finalLabel },
      "failed to set final label — non-critical",
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPromptVars(ctx: ExecutionContext): Record<string, string> {
  const { config, issue, branch, worktreePath } = ctx;
  return {
    PROJECT_NAME: path.basename(config.projectPath),
    REPO_OWNER: config.repoOwner,
    REPO_NAME: config.repoName,
    SPRINT_NUMBER: String(config.sprintNumber),
    ISSUE_NUMBER: String(issue.number),
    ISSUE_TITLE: issue.title,
    ISSUE_BODY: sanitizePromptInput(issue.acceptanceCriteria),
    BRANCH_NAME: branch,
    BASE_BRANCH: config.baseBranch,
    WORKTREE_PATH: worktreePath,
    MAX_DIFF_LINES: String(buildQualityGateConfig(config).maxDiffLines),
  };
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Execute a single sprint issue end-to-end:
 * label → worktree → ACP session → quality gate → huddle → cleanup.
 */
export async function executeIssue(
  client: AcpClient,
  config: SprintConfig,
  issue: SprintIssue,
  eventBus?: SprintEventBus,
): Promise<IssueResult> {
  const log = logger.child({ ceremony: "execution", issue: issue.number });
  const startTime = Date.now();
  const progress = (step: string) =>
    eventBus?.emitTyped("issue:progress", { issueNumber: issue.number, step });

  const branch = buildBranch(config, issue.number);
  const worktreePath = path.resolve(config.worktreeBase, `issue-${issue.number}`);

  const ctx: ExecutionContext = {
    client,
    config,
    issue,
    eventBus,
    log,
    branch,
    worktreePath,
    progress,
  };

  // Step 1: Set in-progress label
  await setStatusLabel(issue.number, "status:in-progress");
  log.info("issue marked in-progress");
  progress("creating worktree");

  let qualityResult: QualityResult = { passed: false, checks: [] };
  let codeReview: CodeReviewResult | undefined;
  let retryCount = 0;
  let filesChanged: string[] = [];
  let status: "completed" | "failed" = "failed";
  let errorMessage: string | undefined;
  let acpOutputLines: string[] = [];
  let timedOut = false;
  let devSessionId: string | undefined;

  try {
    // Step 2: Create worktree
    await createWorktree({ path: worktreePath, branch, base: config.baseBranch });
    log.info({ worktreePath, branch }, "worktree created");

    // Step 3: Plan phase (own ACP session as planner)
    const implementationPlan = await planPhase(ctx);

    // Step 3b: TDD phase (optional — test-engineer writes tests before implementation)
    if (config.enableTdd && implementationPlan) {
      await tddPhase(ctx, implementationPlan);
    }

    // Step 4: Implement phase (session stays open for QG retries)
    try {
      const implResult = await implementPhase(ctx, implementationPlan);
      acpOutputLines = implResult.acpOutputLines;
      devSessionId = implResult.sessionId;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.toLowerCase().includes("timed out")) {
        timedOut = true;
      }
      throw err;
    }

    // Step 5-6: Quality gate + code review (uses developer session for retries)
    const reviewOutcome = await qualityAndReviewPhase(ctx, devSessionId);
    qualityResult = reviewOutcome.qualityResult;
    codeReview = reviewOutcome.codeReview;
    retryCount = reviewOutcome.retryCount;

    // Gather changed files
    filesChanged = await getChangedFiles(branch, config.baseBranch);

    // Zero-change guard
    if (qualityResult.passed && filesChanged.length === 0) {
      log.warn({ issue: issue.number }, "Worker produced 0 file changes — treating as failure");
      status = "failed";
      qualityResult = {
        passed: false,
        checks: [
          ...qualityResult.checks,
          {
            name: "files-changed",
            passed: false,
            detail: "Worker produced 0 file changes",
            category: "other" as const,
          },
        ],
      };
    } else {
      status = qualityResult.passed ? "completed" : "failed";
    }
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : String(err);
    appendErrorLog("error", `Issue #${issue.number} execution failed: ${errorMessage}`, {
      issue: issue.number,
    });
    log.error({ err: errorMessage, issue: issue.number }, "issue execution failed");
    status = "failed";
  } finally {
    // Close developer session after all retries are done
    if (devSessionId) {
      eventBus?.emitTyped("session:end", {
        sessionId: devSessionId,
        outcome: status === "completed" ? "completed" : "failed",
      });
      await client.endSession(devSessionId).catch((err) => {
        log.warn(
          { err, sessionId: devSessionId, issue: issue.number },
          "failed to end developer session — possible session leak",
        );
      });
    }
    // Step 8: Cleanup (worktree, huddle, labels)
    await cleanupPhase(ctx, {
      status,
      qualityResult,
      codeReview,
      retryCount,
      filesChanged,
      errorMessage,
      startTime,
      acpOutputLines,
      timedOut,
    });
  }

  const duration_ms = Date.now() - startTime;

  return {
    issueNumber: issue.number,
    status,
    qualityGatePassed: qualityResult.passed,
    qualityDetails: qualityResult,
    codeReview,
    branch,
    duration_ms,
    filesChanged,
    retryCount,
    points: issue.points,
  };
}
