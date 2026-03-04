import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createIssueRateLimited, type IssueCreationState } from "../github/issue-rate-limiter.js";
import { ensureLabelExists } from "../github/labels.js";
import { logger } from "../logger.js";
import type { EscalationEvent } from "../types.js";
import type { SprintEventBus } from "../events.js";

const execFile = promisify(execFileCb);

const MAX_HTTP_STRING_LENGTH = 500;

/** Sanitize a string for safe use in HTTP headers/body via curl. */
export function sanitizeForHttp(str: string): string {
  return (
    str
      .replace(/[\r\n]+/g, " ")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, "")
      .slice(0, MAX_HTTP_STRING_LENGTH)
  );
}

export interface EscalationConfig {
  ntfyTopic?: string;
  ntfyEnabled: boolean;
  maxIssuesCreatedPerSprint?: number;
}

const DEFAULT_MAX_ISSUES = 10;

export async function escalateToStakeholder(
  event: EscalationEvent,
  config: EscalationConfig,
  eventBus?: SprintEventBus,
  state: IssueCreationState = { issuesCreatedCount: 0 },
): Promise<void> {
  const log = logger.child({ module: "escalation" });

  log.warn(
    { level: event.level, reason: event.reason, issueNumber: event.issueNumber },
    "escalation triggered",
  );

  // Create GitHub issue for escalation
  const issueRef = event.issueNumber ? ` (issue #${event.issueNumber})` : "";
  const labels = ["type:escalation", `priority:${event.level}`];

  // Ensure labels exist before using them
  for (const label of labels) {
    try {
      await ensureLabelExists(label);
    } catch {
      log.debug({ label }, "Could not ensure label exists — will try anyway");
    }
  }

  try {
    const issue = await createIssueRateLimited(
      {
        title: `🚨 Escalation [${event.level}]: ${event.reason}`,
        body: [
          `## Escalation${issueRef}`,
          "",
          `**Level:** ${event.level}`,
          `**Reason:** ${event.reason}`,
          `**Timestamp:** ${event.timestamp.toISOString()}`,
          "",
          "### Detail",
          "",
          event.detail,
          "",
          "### Context",
          "",
          "```json",
          JSON.stringify(event.context, null, 2),
          "```",
        ].join("\n"),
        labels,
      },
      state,
      config.maxIssuesCreatedPerSprint ?? DEFAULT_MAX_ISSUES,
    );

    if (issue) {
      log.info({ number: issue.number }, "escalation issue created");
    } else {
      log.warn(
        { title: event.reason, level: event.level },
        "⚠️  SAFETY-CRITICAL: Escalation issue creation rate-limited — manual intervention required",
      );
    }

    // MUST-level escalation: signal sprint pause
    if (event.level === "must" && eventBus) {
      log.warn("MUST escalation — signaling sprint pause");
      eventBus.emitTyped("sprint:paused", {});
    }
  } catch (err: unknown) {
    // Fall back to creating without labels if label doesn't exist
    log.warn({ err }, "escalation issue creation failed — retrying without labels");
    try {
      const retryIssue = await createIssueRateLimited(
        {
          title: `🚨 Escalation [${event.level}]: ${event.reason}`,
          body: [
            `## Escalation${issueRef}`,
            "",
            `**Level:** ${event.level}`,
            `**Reason:** ${event.reason}`,
            `**Timestamp:** ${event.timestamp.toISOString()}`,
            "",
            "### Detail",
            "",
            event.detail,
          ].join("\n"),
        },
        state,
        config.maxIssuesCreatedPerSprint ?? DEFAULT_MAX_ISSUES,
      );
      if (retryIssue) {
        log.info({ number: retryIssue.number }, "escalation issue created (without labels)");
      } else {
        log.warn("escalation issue creation rate-limited on retry");
      }
    } catch (retryErr: unknown) {
      log.error({ err: retryErr }, "escalation issue creation failed completely");
    }
  }

  // Send ntfy notification if configured
  if (config.ntfyEnabled && config.ntfyTopic) {
    if (!/^[a-zA-Z0-9_-]+$/.test(config.ntfyTopic)) {
      log.error({ topic: config.ntfyTopic }, "invalid ntfy topic — must match [a-zA-Z0-9_-]+");
      return;
    }
    try {
      await execFile("curl", [
        "-s",
        "-o",
        "/dev/null",
        "--max-time",
        "10",
        "--connect-timeout",
        "5",
        "-d",
        `[${event.level}] ${sanitizeForHttp(event.reason)}: ${sanitizeForHttp(event.detail)}`,
        "-H",
        `Title: Escalation: ${sanitizeForHttp(event.reason)}`,
        "-H",
        `Priority: ${event.level === "must" ? "urgent" : event.level === "should" ? "high" : "default"}`,
        `https://ntfy.sh/${config.ntfyTopic}`,
      ]);
      log.info({ topic: config.ntfyTopic }, "ntfy notification sent");
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ error: msg }, "ntfy notification failed");
    }
  }
}
