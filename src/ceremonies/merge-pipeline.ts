import type { AcpClient } from "../acp/client.js";
import type { SprintConfig, IssueResult } from "../types.js";
import { mergeBranch } from "../git/merge.js";
import { deleteBranch } from "../git/worktree.js";
import { logger } from "../logger.js";
import { resolveSessionConfig, applySessionSettings } from "../acp/session-config.js";

export interface MergePipelineResult {
  merged: number[];
  conflicted: number[];
  conflictDetails: Map<number, string[]>;
}

/**
 * Merge completed issue branches back to base.
 *
 * Filters for completed + quality-gate-passed results, attempts merge
 * for each, and returns aggregate results.
 */
export async function mergeCompletedBranches(
  config: SprintConfig,
  results: IssueResult[],
  baseBranch: string,
): Promise<MergePipelineResult> {
  const log = logger.child({ module: "merge-pipeline" });

  const merged: number[] = [];
  const conflicted: number[] = [];
  const conflictDetails = new Map<number, string[]>();

  const eligible = results.filter((r) => r.status === "completed" && r.qualityGatePassed);

  log.info({ total: results.length, eligible: eligible.length }, "starting merge pipeline");

  for (const result of eligible) {
    const { issueNumber, branch } = result;

    try {
      const mergeResult = await mergeBranch(branch, baseBranch, {
        squash: config.squashMerge,
      });

      if (!mergeResult.success) {
        conflicted.push(issueNumber);
        if (mergeResult.conflictFiles?.length) {
          conflictDetails.set(issueNumber, mergeResult.conflictFiles);
        }
        log.warn(
          { issueNumber, branch, conflictFiles: mergeResult.conflictFiles },
          "merge conflict — skipping",
        );
        continue;
      }

      merged.push(issueNumber);

      if (config.deleteBranchAfterMerge) {
        try {
          await deleteBranch(branch);
          log.debug({ branch }, "deleted branch after merge");
        } catch (delErr: unknown) {
          log.warn({ branch, error: (delErr as Error).message }, "failed to delete branch");
        }
      }

      log.info({ issueNumber, branch }, "merged successfully");
    } catch (err: unknown) {
      log.error({ issueNumber, branch, error: (err as Error).message }, "unexpected merge error");
      conflicted.push(issueNumber);
    }
  }

  log.info({ merged: merged.length, conflicted: conflicted.length }, "merge pipeline complete");

  return { merged, conflicted, conflictDetails };
}

/**
 * Attempt to resolve merge conflicts via ACP.
 *
 * Reads a conflict-resolver prompt template, spawns an ACP session,
 * and sends the prompt with conflict details.
 */
export async function resolveConflictsViaAcp(
  client: AcpClient,
  config: SprintConfig,
  branch: string,
  baseBranch: string,
  conflictFiles: string[],
): Promise<boolean> {
  const log = logger.child({ module: "merge-pipeline" });

  const prompt = [
    `Resolve merge conflicts between branch '${branch}' and '${baseBranch}'.`,
    `Conflicting files: ${conflictFiles.join(", ")}`,
    "For each file, read both versions, choose the correct resolution,",
    "and write the resolved content. Prefer the feature branch changes",
    "when they don't break the base branch code.",
  ].join("\n");

  try {
    const sessionConfig = await resolveSessionConfig(config, "conflict-resolver");
    const { sessionId } = await client.createSession({
      cwd: process.cwd(),
      mcpServers: sessionConfig.mcpServers,
    });

    let fullPrompt = prompt;
    if (sessionConfig.instructions) {
      fullPrompt = sessionConfig.instructions + "\n\n" + fullPrompt;
    }
    await applySessionSettings(client, sessionId, sessionConfig);

    const result = await client.sendPrompt(sessionId, fullPrompt);

    await client.endSession(sessionId);

    const succeeded =
      result.stopReason === "end_turn" &&
      !result.response.toLowerCase().includes("unable to resolve");

    log.info(
      { branch, baseBranch, succeeded, stopReason: result.stopReason },
      "ACP conflict resolution attempt",
    );

    return succeeded;
  } catch (err: unknown) {
    log.error({ branch, error: (err as Error).message }, "ACP conflict resolution failed");
    return false;
  }
}
