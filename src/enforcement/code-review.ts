// Automated code review step in the execution pipeline.
// Runs after quality gate passes. Uses ACP with the reviewer model
// to analyze the diff for bugs, security issues, and logic errors.

import type { AcpClient } from "../acp/client.js";
import type { SprintConfig, SprintIssue, CodeReviewResult } from "../types.js";
import { resolveSessionConfig } from "../acp/session-config.js";
import { diffStat } from "../git/diff-analysis.js";
import { logger } from "../logger.js";

/**
 * Run an automated code review on a branch via ACP.
 * Returns approval status and feedback. If rejected, the caller
 * can send feedback to the worker for a fix attempt.
 */
export async function runCodeReview(
  client: AcpClient,
  config: SprintConfig,
  issue: SprintIssue,
  branch: string,
  worktreePath: string,
  eventBus?: import("../events.js").SprintEventBus,
): Promise<CodeReviewResult> {
  const log = logger.child({ module: "code-review", issue: issue.number });

  log.info({ branch }, "starting automated code review");

  const stat = await diffStat(branch, config.baseBranch);

  const sessionConfig = await resolveSessionConfig(config, "reviewer");
  const { sessionId } = await client.createSession({
    cwd: worktreePath,
    mcpServers: sessionConfig.mcpServers,
  });
  eventBus?.emitTyped("session:start", {
    sessionId,
    role: "reviewer",
    issueNumber: issue.number,
    model: sessionConfig.model,
  });

  let outcome: "approved" | "changes_requested" | "failed" | "completed" = "completed";

  try {
    if (sessionConfig.model) {
      await client.setModel(sessionId, sessionConfig.model);
    }

    const prompt = [
      ...(sessionConfig.instructions ? [sessionConfig.instructions, ""] : []),
      "You are an automated code reviewer. Review the changes on this branch.",
      "Focus ONLY on issues that genuinely matter:",
      "- Bugs and logic errors",
      "- Security vulnerabilities",
      "- Missing error handling that could cause crashes",
      "- Breaking changes to public APIs",
      "",
      "Do NOT comment on: style, formatting, naming preferences, or minor suggestions.",
      "",
      `## Issue #${issue.number}: ${issue.title}`,
      `Acceptance criteria: ${issue.acceptanceCriteria}`,
      "",
      `## Diff Stats`,
      `- Lines changed: ${stat.linesChanged}`,
      `- Files changed: ${stat.filesChanged}`,
      `- Files: ${stat.files.join(", ")}`,
      "",
      `## Branch: ${branch} (base: ${config.baseBranch})`,
      "",
      "Review the actual file changes using the tools available to you.",
      "Read the changed files and the diff to understand what was modified.",
      "",
      "Respond with EXACTLY one of these on the FIRST line:",
      "APPROVED: <one-line summary of what looks good>",
      "CHANGES_REQUESTED: <one-line summary of what needs fixing>",
      "",
      "Then list any issues found, one per line, prefixed with '- '.",
      "If approved, you may still list non-blocking suggestions prefixed with '- [suggestion] '.",
    ].join("\n");

    const result = await client.sendPrompt(sessionId, prompt, config.sessionTimeoutMs);
    const response = result.response.trim();

    const firstLine = response.split("\n")[0] ?? "";
    const approved = firstLine.toUpperCase().startsWith("APPROVED");

    // Extract issue lines
    const issues = response
      .split("\n")
      .filter((line) => line.startsWith("- ") && !line.toLowerCase().includes("[suggestion]"))
      .map((line) => line.slice(2).trim());

    log.info({ approved, issueCount: issues.length }, "code review completed");

    outcome = approved ? "approved" : "changes_requested";
    return { approved, feedback: response, issues };
  } finally {
    eventBus?.emitTyped("session:end", { sessionId, outcome });
    await client.endSession(sessionId);
  }
}
