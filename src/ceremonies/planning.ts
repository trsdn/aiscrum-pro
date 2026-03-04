import fs from "node:fs/promises";
import path from "node:path";
import type { AcpClient } from "../acp/client.js";
import type { SprintConfig, SprintPlan } from "../types.js";
import { SprintPlanSchema } from "../types.js";
import type { SprintEventBus } from "../events.js";
import { setStatusLabel, removeLabel } from "../github/labels.js";
import {
  setMilestone,
  getMilestone,
  createMilestone,
  removeMilestone,
} from "../github/milestones.js";
import { listIssues } from "../github/issues.js";
import { createSprintLog } from "../documentation/sprint-log.js";
import { logger } from "../logger.js";
import { substitutePrompt, parseWithRetry } from "./helpers.js";
import { resolveSessionConfig } from "../acp/session-config.js";

/**
 * Run the sprint planning ceremony: send the planner agent instructions
 * to select and sequence backlog issues, then label and milestone them.
 * The agent fetches backlog issues and velocity data itself via MCP tools.
 */
export async function runSprintPlanning(
  client: AcpClient,
  config: SprintConfig,
  eventBus?: SprintEventBus,
): Promise<SprintPlan> {
  const log = logger.child({ ceremony: "planning" });

  // Read prompt template
  const templatePath = path.join(
    config.projectPath,
    ".aiscrum",
    "roles",
    "planner",
    "prompts",
    "planning.md",
  );
  const template = await fs.readFile(templatePath, "utf-8");

  const prompt = substitutePrompt(template, {
    PROJECT_NAME: config.repoName,
    REPO_OWNER: config.repoOwner,
    REPO_NAME: config.repoName,
    SPRINT_NUMBER: String(config.sprintNumber),
    MIN_ISSUES: String(config.minIssuesPerSprint),
    MAX_ISSUES: String(config.maxIssuesPerSprint),
    BASE_BRANCH: config.baseBranch,
  });

  // Create ACP session and send prompt
  const sessionConfig = await resolveSessionConfig(config, "planning");
  const { sessionId } = await client.createSession({
    cwd: config.projectPath,
    mcpServers: sessionConfig.mcpServers,
  });
  eventBus?.emitTyped("session:start", { sessionId, role: "planning" });
  try {
    let fullPrompt = prompt;
    if (sessionConfig.instructions) {
      fullPrompt = sessionConfig.instructions + "\n\n" + fullPrompt;
    }
    if (sessionConfig.model) {
      await client.setModel(sessionId, sessionConfig.model);
    }
    // Retry full prompt on timeout/crash; use parseWithRetry for JSON parse errors
    const MAX_PLANNING_ATTEMPTS = 2;
    let plan: SprintPlan | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_PLANNING_ATTEMPTS; attempt++) {
      try {
        const result = await client.sendPrompt(sessionId, fullPrompt, config.sessionTimeoutMs);
        plan = (await parseWithRetry(SprintPlanSchema, result.response, async (formatHint) => {
          log.warn("Planning parse failed — retrying with format hint");
          eventBus?.emitTyped("log", {
            level: "warn",
            message: "Planning parse failed, retrying with format hint…",
          });
          const retry = await client.sendPrompt(sessionId, formatHint, config.sessionTimeoutMs);
          return retry.response;
        })) as SprintPlan;
        break;
      } catch (err: unknown) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_PLANNING_ATTEMPTS) {
          log.warn({ attempt, error: msg }, "Planning attempt failed — retrying");
          eventBus?.emitTyped("log", {
            level: "warn",
            message: `Planning attempt ${attempt} failed (${msg.slice(0, 100)}), retrying…`,
          });
        }
      }
    }
    if (!plan) {
      throw lastError;
    }

    // Handle empty plan — planner found no actionable issues
    if (plan.sprint_issues.length === 0) {
      log.info("Planner returned 0 issues — no actionable backlog items for this sprint");
      eventBus?.emitTyped("log", {
        level: "info",
        message: "No actionable backlog issues found — sprint will be skipped",
      });
      return plan;
    }

    // Enforce max_issues — LLM may return more than requested
    if (plan.sprint_issues.length > config.maxIssuesPerSprint) {
      log.warn(
        { returned: plan.sprint_issues.length, max: config.maxIssuesPerSprint },
        "planner returned more issues than max — truncating",
      );
      plan.sprint_issues = plan.sprint_issues.slice(0, config.maxIssuesPerSprint);
    }

    log.info(
      {
        sprintNumber: plan.sprintNumber,
        issueCount: plan.sprint_issues.length,
        estimatedPoints: plan.estimated_points,
      },
      "Sprint plan created",
    );

    // Ensure milestone exists
    const milestoneTitle = `${config.sprintPrefix} ${config.sprintNumber}`;
    const existing = await getMilestone(milestoneTitle);
    if (!existing) {
      await createMilestone(
        milestoneTitle,
        `${config.sprintPrefix} ${config.sprintNumber} milestone`,
      );
    }

    // Set labels and milestone on each selected issue
    const plannedNumbers = new Set(plan.sprint_issues.map((i) => i.number));
    for (const issue of plan.sprint_issues) {
      await setStatusLabel(issue.number, "status:planned");
      await setMilestone(issue.number, milestoneTitle);
      log.debug({ issue: issue.number }, "Labeled and milestoned issue");
    }

    // Remove milestone from issues that were previously assigned but not selected
    try {
      const milestoneIssues = await listIssues({ milestone: milestoneTitle, state: "open" });
      for (const issue of milestoneIssues) {
        if (!plannedNumbers.has(issue.number)) {
          await removeMilestone(issue.number);
          try {
            await removeLabel(issue.number, "status:planned");
          } catch {
            /* may not have it */
          }
          log.info({ issue: issue.number }, "Removed unplanned issue from sprint milestone");
        }
      }
    } catch (err) {
      log.warn(
        { err: String(err) },
        "Failed to clean up unplanned milestone issues — non-critical",
      );
    }

    // Update sprint log
    createSprintLog(
      config.sprintNumber,
      plan.rationale,
      plan.sprint_issues.length,
      undefined,
      config.sprintPrefix,
      config.sprintSlug,
    );

    return plan;
  } finally {
    await client.endSession(sessionId);
    eventBus?.emitTyped("session:end", { sessionId });
  }
}
