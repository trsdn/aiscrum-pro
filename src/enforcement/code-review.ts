// Automated code review step in the execution pipeline.
// Runs after quality gate passes. Uses ACP with the reviewer model
// to analyze the diff for bugs, security issues, and logic errors.

import type { AcpClient } from "../acp/client.js";
import type { SprintConfig, SprintIssue, CodeReviewResult } from "../types.js";
import { CodeReviewActionSchema } from "../types/schemas.js";
import { resolveSessionConfig } from "../acp/session-config.js";
import { diffStat } from "../git/diff-analysis.js";
import { parseWithRetry } from "../ceremonies/helpers.js";
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

  let outcome: "approved" | "changes_requested" | "failed" = "failed";

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
      "Write your review as readable text first, then include a JSON block at the end.",
      "The JSON must be in a ```json fenced code block with this exact structure:",
      "```",
      "{",
      '  "decision": "approved" | "changes_requested" | "failed",',
      '  "reasoning": "why you made this decision",',
      '  "summary": "one-line summary",',
      '  "issues": ["issue 1", "issue 2"]',
      "}",
      "```",
      'Use "approved" if no blocking issues found.',
      'Use "changes_requested" if there are issues to fix (issues array must not be empty).',
      'Use "failed" only if the review itself could not be completed.',
    ].join("\n");

    const result = await client.sendPrompt(sessionId, prompt, config.sessionTimeoutMs);

    const action = await parseWithRetry(CodeReviewActionSchema, result.response, async (hint) => {
      const retry = await client.sendPrompt(sessionId, hint, config.sessionTimeoutMs);
      return retry.response;
    });

    const approved = action.decision === "approved";

    log.info(
      { decision: action.decision, issueCount: action.issues.length, reasoning: action.reasoning },
      "code review completed",
    );

    outcome = approved ? "approved" : "changes_requested";
    return { approved, feedback: result.response, issues: action.issues };
  } finally {
    eventBus?.emitTyped("session:end", { sessionId, outcome });
    await client.endSession(sessionId);
  }
}
