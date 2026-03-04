import { diffStat } from "../git/diff-analysis.js";
import { getIssue } from "../github/issues.js";
import { logger } from "../logger.js";
import type { AcpClient } from "../acp/client.js";
import type { SprintConfig } from "../types.js";
import { ChallengerActionSchema } from "../types/schemas.js";
import { resolveSessionConfig } from "../acp/session-config.js";
import { parseWithRetry } from "../ceremonies/helpers.js";

export interface ChallengerResult {
  approved: boolean;
  feedback: string;
}

export async function runChallengerReview(
  client: AcpClient,
  config: SprintConfig,
  branch: string,
  issueNumber: number,
): Promise<ChallengerResult> {
  const log = logger.child({ module: "challenger" });

  log.info({ branch, issueNumber }, "starting challenger review");

  const [issue, stat] = await Promise.all([
    getIssue(issueNumber),
    diffStat(branch, config.baseBranch),
  ]);

  const sessionConfig = await resolveSessionConfig(config, "challenger");
  const { sessionId } = await client.createSession({
    cwd: config.projectPath,
    mcpServers: sessionConfig.mcpServers,
  });

  const prompt = [
    ...(sessionConfig.instructions ? [sessionConfig.instructions, ""] : []),
    "You are an adversarial code reviewer (the Challenger).",
    "Review this change critically. Look for:",
    "- Scope creep beyond the issue",
    "- Missing tests or inadequate coverage",
    "- Architectural violations",
    "- Security concerns",
    "- Performance regressions",
    "",
    `## Issue #${issueNumber}: ${issue.title}`,
    "",
    issue.body,
    "",
    `## Diff Stats`,
    `- Lines changed: ${stat.linesChanged}`,
    `- Files changed: ${stat.filesChanged}`,
    `- Files: ${stat.files.join(", ")}`,
    "",
    `## Branch: ${branch} (base: ${config.baseBranch})`,
    "",
    "Respond with EXACTLY one of these on the first line:",
    "APPROVED: <one-line summary>",
    "REJECTED: <one-line reason>",
    "",
    "Then provide detailed feedback below.",
    "",
    "At the end, include a JSON block in a ```json fenced code block:",
    "```",
    "{",
    '  "decision": "approved" | "rejected",',
    '  "reasoning": "why you made this decision",',
    '  "feedback": "detailed feedback text"',
    "}",
    "```",
  ].join("\n");

  if (sessionConfig.model) {
    await client.setModel(sessionId, sessionConfig.model);
  }

  const result = await client.sendPrompt(sessionId, prompt, config.sessionTimeoutMs);

  const action = await parseWithRetry(ChallengerActionSchema, result.response, async (hint) => {
    const retry = await client.sendPrompt(sessionId, hint, config.sessionTimeoutMs);
    return retry.response;
  });

  await client.endSession(sessionId);

  const approved = action.decision === "approved";

  log.info(
    { decision: action.decision, issueNumber, reasoning: action.reasoning },
    "challenger review completed",
  );

  return {
    approved,
    feedback: result.response,
  };
}
