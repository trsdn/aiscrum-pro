import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
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
import { logger } from "../logger.js";
import { substitutePrompt, extractJson, sanitizePromptInput } from "./helpers.js";
import { resolveSessionConfig, applySessionSettings } from "../acp/session-config.js";
import { createIssue } from "../github/issues.js";
import { RetroResultSchema, normalizeRetroFields } from "../types/schemas.js";

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

  // Read prompt template
  const templatePath = path.join(
    config.projectPath,
    ".aiscrum",
    "roles",
    "retro",
    "prompts",
    "retro.md",
  );
  const template = await fs.readFile(templatePath, "utf-8");

  const prompt = substitutePrompt(template, {
    PROJECT_NAME: config.repoName,
    REPO_OWNER: config.repoOwner,
    REPO_NAME: config.repoName,
    SPRINT_NUMBER: String(config.sprintNumber),
    SPRINT_REVIEW_DATA: sanitizePromptInput(JSON.stringify({ review, metrics })),
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
    await applySessionSettings(client, sessionId, sessionConfig);
    const response = await client.sendPrompt(sessionId, fullPrompt, config.sessionTimeoutMs);

    let rawRetro: Record<string, unknown>;
    try {
      rawRetro = extractJson<Record<string, unknown>>(response.response);
    } catch {
      log.warn("retro JSON extraction failed — retrying with format hint");
      const retryHint = [
        "Your response could not be parsed as JSON.",
        "IMPORTANT: Respond with ONLY a JSON block — no markdown, no explanation.",
        "```json",
        '{ "wentWell": ["..."], "wentBadly": ["..."], "improvements": [{ "title": "...", "description": "...", "autoApplicable": false, "target": "process" }] }',
        "```",
      ].join("\n");
      const retryResponse = await client.sendPrompt(sessionId, retryHint, config.sessionTimeoutMs);
      rawRetro = extractJson<Record<string, unknown>>(retryResponse.response);
    }

    // Normalize LLM field name variations, then validate via Zod schema
    const normalized = normalizeRetroFields(rawRetro);
    const retro: RetroResult = RetroResultSchema.parse(normalized);

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
          log.warn(
            { err: String(issueErr), title },
            "Failed to create backlog issue for process improvement",
          );
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
    await applySessionSettings(client, sessionId, sessionConfig);

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
          "Edit `.aiscrum/config.yaml` in the project root. " +
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

    // Validate config after ACP edits to prevent corruption
    if (improvement.target === "config") {
      const configFile = path.join(config.projectPath, ".aiscrum", "config.yaml");
      try {
        const raw = await fs.readFile(configFile, "utf-8");
        yaml.parse(raw); // Throws on invalid YAML
      } catch (parseErr: unknown) {
        log.error(
          { err: String(parseErr), title: improvement.title },
          "Retro improvement corrupted config — reverting",
        );
        // Revert via git checkout
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const exec = promisify(execFile);
        await exec("git", ["checkout", "--", configFile], { cwd: config.projectPath });
        throw new Error(`Config validation failed after retro improvement: ${String(parseErr)}`);
      }
    }

    log.info({ title: improvement.title }, "Applied improvement via ACP");
  } catch (err: unknown) {
    log.warn({ err: String(err), title: improvement.title }, "Failed to auto-apply improvement");
  } finally {
    eventBus?.emitTyped("session:end", { sessionId });
    await client.endSession(sessionId);
  }
}
