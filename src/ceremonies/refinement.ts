import fs from "node:fs/promises";
import path from "node:path";
import type { AcpClient } from "../acp/client.js";
import type { SprintConfig, RefinedIssue } from "../types.js";
import type { SprintEventBus } from "../events.js";
import { listIssues } from "../github/issues.js";
import { logger } from "../logger.js";
import { substitutePrompt, extractJson } from "./helpers.js";
import { resolveSessionConfig } from "../acp/session-config.js";

interface RefinementResponse {
  refined_issues: Array<{
    number: number;
    title: string;
    ice_score: number;
  }>;
}

/**
 * Run the refinement ceremony: load idea issues, ask ACP to refine them,
 * and return structured refined issues.
 */
export async function runRefinement(
  client: AcpClient,
  config: SprintConfig,
  eventBus?: SprintEventBus,
): Promise<RefinedIssue[]> {
  const log = logger.child({ ceremony: "refinement" });

  // Load idea issues
  const ideas = await listIssues({ labels: ["type:idea"], state: "open" });
  if (ideas.length === 0) {
    log.info("No type:idea issues found — skipping refinement");
    return [];
  }
  log.info({ count: ideas.length }, "Loaded idea issues for refinement");

  // Read prompt template
  const templatePath = path.join(config.projectPath, ".aiscrum", "roles", "refiner", "prompts", "refinement.md");
  const template = await fs.readFile(templatePath, "utf-8");

  const prompt = substitutePrompt(template, {
    PROJECT_NAME: config.repoName,
    REPO_OWNER: config.repoOwner,
    REPO_NAME: config.repoName,
    SPRINT_NUMBER: String(config.sprintNumber),
    BASE_BRANCH: config.baseBranch,
  });

  // Create ACP session and send prompt
  const sessionConfig = await resolveSessionConfig(config, "refinement");
  const { sessionId } = await client.createSession({
    cwd: config.projectPath,
    mcpServers: sessionConfig.mcpServers,
  });
  eventBus?.emitTyped("session:start", { sessionId, role: "refinement" });
  try {
    let fullPrompt = prompt;
    if (sessionConfig.instructions) {
      fullPrompt = sessionConfig.instructions + "\n\n" + fullPrompt;
    }
    if (sessionConfig.model) {
      await client.setModel(sessionId, sessionConfig.model);
    }
    const result = await client.sendPrompt(sessionId, fullPrompt, config.sessionTimeoutMs);
    const parsed = extractJson<RefinementResponse>(result.response);

    // Ensure refined_issues array exists (model may omit it)
    const refinedIssues = parsed.refined_issues ?? [];
    const refined: RefinedIssue[] = refinedIssues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      ice_score: issue.ice_score,
    }));

    // Validate each issue has acceptance criteria (non-zero ICE implies valid)
    for (const issue of refined) {
      if (issue.ice_score <= 0) {
        log.warn({ issue: issue.number }, "Issue has zero or negative ICE score");
      }
    }

    // Log ICE scores
    for (const issue of refined) {
      log.info(
        { number: issue.number, title: issue.title, ice_score: issue.ice_score },
        "Refined issue",
      );
    }

    return refined;
  } finally {
    await client.endSession(sessionId);
    eventBus?.emitTyped("session:end", { sessionId });
  }
}
