import fs from "node:fs/promises";
import path from "node:path";
import type { AcpClient } from "../acp/client.js";
import type { SprintConfig, SprintPlan } from "../types.js";
import { SprintPlanSchema } from "../types.js";
import type { SprintEventBus } from "../events.js";
import { setLabel } from "../github/labels.js";
import { setMilestone, getMilestone, createMilestone } from "../github/milestones.js";
import { createSprintLog } from "../documentation/sprint-log.js";
import { logger } from "../logger.js";
import { substitutePrompt, extractJson } from "./helpers.js";
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
  const templatePath = path.join(config.projectPath, ".aiscrum", "roles", "planner", "prompts", "planning.md");
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
    const result = await client.sendPrompt(sessionId, fullPrompt, config.sessionTimeoutMs);
    const plan = SprintPlanSchema.parse(
      extractJson(result.response),
    ) as SprintPlan;

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
      await createMilestone(milestoneTitle, `${config.sprintPrefix} ${config.sprintNumber} milestone`);
    }

    // Set labels and milestone on each selected issue
    for (const issue of plan.sprint_issues) {
      await setLabel(issue.number, "status:planned");
      await setMilestone(issue.number, milestoneTitle);
      log.debug({ issue: issue.number }, "Labeled and milestoned issue");
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
