import fs from "node:fs/promises";
import path from "node:path";
import type { AcpClient } from "../acp/client.js";
import type {
  SprintConfig,
  SprintResult,
  ReviewResult,
  RetroResult,
  RetroImprovement,
} from "../types.js";
import type { SprintEventBus } from "../events.js";
import { calculateSprintMetrics } from "../metrics.js";
import { readVelocity } from "../documentation/velocity.js";
import { logger } from "../logger.js";
import { substitutePrompt, extractJson, sanitizePromptInput } from "./helpers.js";
import { resolveSessionConfig } from "../acp/session-config.js";
import { createIssue } from "../github/issues.js";

/**
 * Run the sprint retro ceremony: analyse sprint data, ask ACP for
 * improvements, and auto-apply all improvement types.
 */
export async function runSprintRetro(
  client: AcpClient,
  config: SprintConfig,
  result: SprintResult,
  review: ReviewResult,
  eventBus?: SprintEventBus,
  _state?: unknown,
): Promise<RetroResult> {
  const log = logger.child({ ceremony: "retro" });

  // Calculate metrics
  const metrics = calculateSprintMetrics(result);

  // Read velocity data
  const velocity = readVelocity();
  const velocityStr = JSON.stringify(velocity);

  // Load previous retro improvements (best-effort)
  let previousImprovements = "None available";
  const prevRetroPath = path.join(
    config.projectPath,
    "docs",
    "sprints",
    `sprint-${config.sprintNumber - 1}-retro.md`,
  );
  try {
    previousImprovements = await fs.readFile(prevRetroPath, "utf-8");
  } catch {
    log.debug("No previous retro file found — using empty context");
  }

  // Read sprint runner config for context (filtered to sprint-relevant keys)
  let runnerConfig = "";
  const configPath = path.join(config.projectPath, "sprint-runner.config.yaml");
  try {
    const rawConfig = await fs.readFile(configPath, "utf-8");
    // Filter to sprint-relevant keys only
    const lines = rawConfig.split("\n");
    const relevantKeys = ["sprintPrefix", "qualityGate", "maxParallel", "sessionTimeout", "backlogLabels", "maxRetries"];
    const filteredLines = lines.filter(line => {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) return true;
      return relevantKeys.some(key => trimmed.startsWith(key));
    });
    runnerConfig = filteredLines.join("\n");
  } catch {
    log.debug("No sprint runner config found");
  }

  // Read prompt template
  const templatePath = path.join(config.projectPath, ".aiscrum", "roles", "retro", "prompts", "retro.md");
  const template = await fs.readFile(templatePath, "utf-8");

  // Build failure diagnostics from sprint results
  const failureDiagnostics = result.results
    .filter((r) => r.status === "failed")
    .map((r) => ({
      issueNumber: r.issueNumber,
      qualityChecks: r.qualityDetails.checks
        .filter((c) => !c.passed)
        .map((c) => `${c.name}: ${c.detail}`),
      codeReviewFeedback: r.codeReview?.feedback ?? null,
      retryCount: r.retryCount,
    }));

  const prompt = substitutePrompt(template, {
    PROJECT_NAME: path.basename(config.projectPath),
    REPO_OWNER: config.repoOwner,
    REPO_NAME: config.repoName,
    SPRINT_NUMBER: String(config.sprintNumber),
    SPRINT_REVIEW_DATA: sanitizePromptInput(JSON.stringify({ review, metrics })),
    VELOCITY_DATA: velocityStr,
    PREVIOUS_RETRO_IMPROVEMENTS: sanitizePromptInput(previousImprovements),
    SPRINT_RUNNER_CONFIG: runnerConfig,
    FAILURE_DIAGNOSTICS: sanitizePromptInput(JSON.stringify(failureDiagnostics)),
  });

  // Create ACP session and send prompt
  const sessionConfig = await resolveSessionConfig(config, "retro");
  const { sessionId } = await client.createSession({
    cwd: config.projectPath,
    mcpServers: sessionConfig.mcpServers,
  });
  eventBus?.emitTyped("session:start", { sessionId, role: "retro" });
  try {
    let fullPrompt = prompt;
    if (sessionConfig.instructions) {
      fullPrompt = sessionConfig.instructions + "\n\n" + fullPrompt;
    }
    if (sessionConfig.model) {
      await client.setModel(sessionId, sessionConfig.model);
    }
    const response = await client.sendPrompt(sessionId, fullPrompt, config.sessionTimeoutMs);
    const rawRetro = extractJson<Record<string, unknown>>(response.response);

    // Normalize field names: ACP may return snake_case or the prompt's format
    const retro: RetroResult = {
      wentWell: (rawRetro.wentWell ?? rawRetro.went_well ?? []) as string[],
      wentBadly: (rawRetro.wentBadly ?? rawRetro.went_poorly ?? []) as string[],
      improvements: [],
      previousImprovementsChecked: (rawRetro.previousImprovementsChecked ?? rawRetro.previous_improvements_applied !== undefined) as boolean,
    };

    // Normalize improvements: prompt format uses problem/action/category,
    // code expects title/description/target/autoApplicable
    const rawImprovements = (rawRetro.improvements ?? []) as Record<string, unknown>[];
    for (const raw of rawImprovements) {
      const title = (raw.title as string) || (raw.action as string) || (raw.problem as string) || "";
      const description = (raw.description as string) ||
        [raw.problem, raw.root_cause, raw.action, raw.expected_outcome]
          .filter(Boolean)
          .join(" — ") ||
        "";
      const categoryMap: Record<string, RetroImprovement["target"]> = {
        config: "config", agent: "agent", skill: "skill", process: "process",
      };
      const target = (raw.target as RetroImprovement["target"]) ||
        categoryMap[(raw.category as string)?.toLowerCase()] ||
        "process";
      const autoApplicable = raw.autoApplicable !== undefined ? Boolean(raw.autoApplicable) : true;

      retro.improvements.push({ title, description, autoApplicable, target });
    }

    log.info(
      {
        wentWell: retro.wentWell.length,
        wentBadly: retro.wentBadly.length,
        improvements: retro.improvements.length,
      },
      "Sprint retro completed",
    );

    // Process improvements: auto-apply all types
    for (const improvement of retro.improvements) {
      const title = improvement.title;
      const description = improvement.description;
      if (!title || typeof title !== "string" || title.trim().length === 0) {
        log.warn({ improvement }, "Skipping improvement with missing or empty title");
        continue;
      }
      if (!description || typeof description !== "string" || description.trim().length === 0) {
        log.warn({ title }, "Skipping improvement with missing or empty description");
        continue;
      }

      if (!improvement.autoApplicable) {
        log.warn({ title, target: improvement.target }, "Skipping non-auto-applicable improvement");
        continue;
      }

      // Only auto-apply prompt/config changes (skill, agent, config targets).
      // Process-level changes (code in src/, enforcement, ceremonies) require human oversight.
      if (improvement.target === "process") {
        log.info({ title }, "Process improvement requires human decision — creating backlog issue");
        try {
          await createIssue({
            title: `[Retro] ${title}`,
            body: [
              `## Retro Improvement — Requires Human Decision`,
              "",
              `**Target:** ${improvement.target}`,
              `**Description:** ${description}`,
              "",
              `This improvement was identified during sprint retrospective but targets process/code changes that require human oversight before applying.`,
            ].join("\n"),
            labels: ["human-decision-needed", "type:improvement"],
          });
        } catch (issueErr) {
          log.warn({ err: String(issueErr), title }, "Failed to create backlog issue for process improvement");
        }
        continue;
      }

      await applyImprovement(client, config, improvement, eventBus);
      log.info({ title, target: improvement.target }, "Auto-applied improvement");
    }

    return retro;
  } finally {
    await client.endSession(sessionId);
    eventBus?.emitTyped("session:end", { sessionId });
  }
}

/**
 * Auto-apply an improvement by sending the improvement description
 * to an ACP session that edits the appropriate files based on target type.
 */
async function applyImprovement(
  client: AcpClient,
  config: SprintConfig,
  improvement: RetroImprovement,
  eventBus?: SprintEventBus,
): Promise<void> {
  const log = logger.child({ ceremony: "retro", target: improvement.target });
  const sessionConfig = await resolveSessionConfig(config, "worker");
  const { sessionId } = await client.createSession({
    cwd: config.projectPath,
    mcpServers: sessionConfig.mcpServers,
  });
  eventBus?.emitTyped("session:start", { sessionId, role: "retro-apply" });
  try {
    if (sessionConfig.model) {
      await client.setModel(sessionId, sessionConfig.model);
    }

    let targetInstruction: string;
    switch (improvement.target) {
      case "skill":
      case "agent":
        targetInstruction =
          "Edit files under `.aiscrum/roles/`. " +
          "Look at the existing files to understand the structure, then make minimal targeted changes.";
        break;
      case "config":
        targetInstruction =
          "Edit `sprint-runner.config.yaml` in the project root. " +
          "Preserve existing structure and comments. Only change the relevant settings.";
        break;
      case "process":
        targetInstruction =
          "Edit ceremony or enforcement code under `src/ceremonies/`, `src/enforcement/`, " +
          "or prompt files under `.aiscrum/roles/*/prompts/`. " +
          "Make minimal targeted changes to the relevant files.";
        break;
    }

    const prompt = [
      `## Apply Retro Improvement`,
      "",
      `**Title:** ${improvement.title}`,
      `**Target:** ${improvement.target}`,
      `**Description:** ${improvement.description}`,
      "",
      targetInstruction,
      `Do NOT create new files — only edit existing ones.`,
    ].join("\n");
    await client.sendPrompt(sessionId, prompt, config.sessionTimeoutMs);
    log.info({ title: improvement.title }, "Applied improvement via ACP");
  } catch (err: unknown) {
    log.warn({ err: String(err), title: improvement.title }, "Failed to auto-apply improvement");
  } finally {
    eventBus?.emitTyped("session:end", { sessionId });
    await client.endSession(sessionId);
  }
}
