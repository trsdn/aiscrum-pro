import pLimit from "p-limit";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { AcpClient } from "../acp/client.js";
import type {
  SprintConfig,
  SprintPlan,
  SprintResult,
  IssueResult,
} from "../types.js";
import { buildExecutionGroups } from "./dep-graph.js";
import { executeIssue } from "./execution.js";
import { hasConflicts, mergeIssuePR } from "../git/merge.js";
import { createWorktree, removeWorktree } from "../git/worktree.js";
import { verifyMainBranch } from "../enforcement/quality-gate.js";
import { buildQualityGateConfig } from "./quality-retry.js";
import { escalateToStakeholder } from "../enforcement/escalation.js";
import { setLabel } from "../github/labels.js";
import { addComment } from "../github/issues.js";
import { logger, appendErrorLog } from "../logger.js";

import type { SprintEventBus } from "../events.js";

const execFile = promisify(execFileCb);

/**
 * Verify a feature branch can merge cleanly into base and still pass tests.
 * Creates a temporary worktree, merges base into it, and runs tests + type check.
 */
async function runPreMergeVerification(
  branch: string,
  config: SprintConfig,
): Promise<{ passed: boolean; reason?: string }> {
  const log = logger.child({ module: "pre-merge-verify" });

  // 1. Check for conflicts first (fast, no worktree needed)
  try {
    const conflicts = await hasConflicts(branch, config.baseBranch);
    if (conflicts) {
      return { passed: false, reason: "Merge conflicts detected with " + config.baseBranch };
    }
  } catch (err) {
    log.warn({ err }, "conflict check failed — proceeding to full verification");
  }

  // 2. Create temporary worktree
  const tmpDir = path.join(os.tmpdir(), `pre-merge-${branch.replace(/\//g, "-")}-${Date.now()}`);
  try {
    await createWorktree({ path: tmpDir, branch: `pre-merge-test-${Date.now()}`, base: branch });

    // 3. Merge base into it
    await execFile("git", ["fetch", "origin", config.baseBranch], { cwd: tmpDir });
    await execFile("git", ["merge", `origin/${config.baseBranch}`, "--no-edit"], { cwd: tmpDir });

    // 3.5. Install dependencies if package.json exists (worktree has no node_modules)
    try {
      await fs.access(path.join(tmpDir, "package.json"));
      const lockFile = await fs.access(path.join(tmpDir, "package-lock.json")).then(() => true).catch(() => false);
      const installCmd = lockFile ? "ci" : "install";
      await execFile("npm", [installCmd, "--ignore-scripts"], { cwd: tmpDir, timeout: 120_000 });
    } catch {
      // No package.json or install failed — proceed anyway, tests may still work
      log.debug("npm install skipped in pre-merge worktree");
    }

    // 4. Run tests + type check
    const gateConfig = buildQualityGateConfig(config);
    const testCmd = Array.isArray(gateConfig.testCommand) ? gateConfig.testCommand : gateConfig.testCommand.split(" ");
    const typeCmd = Array.isArray(gateConfig.typecheckCommand) ? gateConfig.typecheckCommand : gateConfig.typecheckCommand.split(" ");

    try {
      await execFile(testCmd[0], testCmd.slice(1), { cwd: tmpDir, timeout: 120_000 });
    } catch {
      return { passed: false, reason: "Tests failed after merging " + config.baseBranch };
    }

    try {
      await execFile(typeCmd[0], typeCmd.slice(1), { cwd: tmpDir, timeout: 60_000 });
    } catch {
      return { passed: false, reason: "Type check failed after merging " + config.baseBranch };
    }

    return { passed: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendErrorLog("error", `Pre-merge verification error: ${msg}`, { tmpDir });
    return { passed: false, reason: `Pre-merge verification error: ${msg}` };
  } finally {
    // 5. Cleanup
    try {
      await removeWorktree(tmpDir);
    } catch {
      appendErrorLog("warn", "failed to cleanup pre-merge worktree", { tmpDir });
      log.warn({ tmpDir }, "failed to cleanup pre-merge worktree");
    }
  }
}

/**
 * Execute sprint issues in parallel, respecting dependency groups.
 * Groups run sequentially; issues within a group run concurrently
 * up to config.maxParallelSessions.
 */
export async function runParallelExecution(
  client: AcpClient,
  config: SprintConfig,
  plan: SprintPlan,
  eventBus?: SprintEventBus,
): Promise<SprintResult> {
  const log = logger.child({ ceremony: "parallel-dispatcher" });
  const groups = buildExecutionGroups(plan.sprint_issues);
  const allResults: IssueResult[] = [];
  let mergeConflicts = 0;

  const issueMap = new Map(plan.sprint_issues.map((i) => [i.number, i]));

  for (const group of groups) {
    log.info({ group: group.group, issues: group.issues }, "executing group");

    const limit = pLimit(config.maxParallelSessions);

    const settled = await Promise.allSettled(
      group.issues.map((issueNumber) =>
        limit(async () => {
          const issue = issueMap.get(issueNumber);
          if (!issue) {
            throw new Error(`Issue #${issueNumber} not found in sprint plan`);
          }
          return executeIssue(client, config, issue, eventBus);
        }),
      ),
    );

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      if (outcome.status === "fulfilled") {
        const result = outcome.value;
        allResults.push(result);

        // Merge successful branches back to base via GitHub PR
        if (config.autoMerge && result.status === "completed") {
          // Rebase branch on latest main before pre-merge (main may have changed from earlier merges)
          // Use a temporary worktree to avoid "unstaged changes" errors in the main repo
          let rebaseSucceeded = true;
          const rebaseTmpDir = path.join(os.tmpdir(), `rebase-${result.branch.replace(/\//g, "-")}-${Date.now()}`);
          try {
            await execFile("git", ["fetch", "origin", config.baseBranch], { cwd: config.projectPath });
            await createWorktree({ path: rebaseTmpDir, branch: `rebase-tmp-${Date.now()}`, base: result.branch });
            await execFile("git", ["rebase", `origin/${config.baseBranch}`], { cwd: rebaseTmpDir });
            await execFile("git", ["push", "origin", `HEAD:${result.branch}`, "--force-with-lease"], { cwd: rebaseTmpDir });
          } catch (rebaseErr) {
            rebaseSucceeded = false;
            // Rebase failed (conflicts) — abort and let pre-merge catch it
            try { await execFile("git", ["rebase", "--abort"], { cwd: rebaseTmpDir }); } catch { /* ignore */ }
            appendErrorLog("warn", `rebase on latest main failed — issue #${result.issueNumber}`, { issue: result.issueNumber, err: String(rebaseErr) });
            log.warn({ issue: result.issueNumber, err: String(rebaseErr) }, "rebase on latest main failed — proceeding to pre-merge");
          } finally {
            try { await removeWorktree(rebaseTmpDir); } catch { /* ignore */ }
          }

          // Pre-merge verification: test feature branch with main merged in
          const premerge = await runPreMergeVerification(result.branch, config);
          if (!premerge.passed) {
            // On rebase conflict, re-execute issue from latest main (counts as retry)
            if (!rebaseSucceeded && config.maxRetries > 0) {
              const issue = issueMap.get(result.issueNumber);
              if (issue) {
                log.info({ issue: result.issueNumber }, "rebase conflict — re-executing issue from latest main");
                await addComment(result.issueNumber, "⚠️ Merge conflict detected. Re-executing from latest main...").catch(() => {});
                try { await execFile("git", ["push", "origin", "--delete", result.branch], { cwd: config.projectPath }); } catch { /* may not exist */ }
                try { await execFile("git", ["branch", "-D", result.branch], { cwd: config.projectPath }); } catch { /* ignore */ }
                const retryResult = await executeIssue(client, config, issue, eventBus);
                allResults[allResults.length - 1] = retryResult;
                if (retryResult.status === "completed") {
                  const retryPremerge = await runPreMergeVerification(retryResult.branch, config);
                  if (retryPremerge.passed) {
                    try {
                      const retryMerge = await mergeIssuePR(retryResult.branch, {
                        squash: config.squashMerge,
                        deleteBranch: config.deleteBranchAfterMerge,
                      });
                      if (retryMerge.success) {
                        log.info({ issue: retryResult.issueNumber, pr: retryMerge.prNumber }, "PR merged after conflict retry");
                        try {
                          const gateConfig = buildQualityGateConfig(config);
                          const verifyResult = await verifyMainBranch(config.projectPath, gateConfig);
                          if (!verifyResult.passed) {
                            const failedChecks = verifyResult.checks.filter((c) => !c.passed).map((c) => c.name).join(", ");
                            log.error({ issue: retryResult.issueNumber, failedChecks }, "post-merge verification FAILED on main");
                            await escalateToStakeholder({
                              level: "must",
                              reason: `Post-merge verification failed after merging #${retryResult.issueNumber}`,
                              detail: `Failed checks: ${failedChecks}. Main branch may be broken.`,
                              context: { issueNumber: retryResult.issueNumber, branch: retryResult.branch },
                              timestamp: new Date(),
                            }, { ntfyEnabled: !!config.ntfy?.enabled, ntfyTopic: config.ntfy?.topic }, eventBus);
                          }
                        } catch (verifyErr: unknown) {
                          appendErrorLog("error", `post-merge verification failed (retry) — issue #${retryResult.issueNumber}`, { issue: retryResult.issueNumber, err: String(verifyErr) });
                          log.error({ err: verifyErr, issue: retryResult.issueNumber }, "post-merge verification could not run");
                        }
                        continue;
                      }
                    } catch { /* fall through to mark failed */ }
                  }
                }
                // Retry didn't resolve the conflict
                retryResult.status = "failed";
                retryResult.qualityGatePassed = false;
                await setLabel(retryResult.issueNumber, "status:blocked");
                await addComment(retryResult.issueNumber, "**Block reason:** Pre-merge verification failed after conflict retry").catch(() => {});
                continue;
              }
            }
            log.warn({ issue: result.issueNumber, reason: premerge.reason }, "pre-merge verification failed");
            result.status = "failed";
            result.qualityGatePassed = false;
            await setLabel(result.issueNumber, "status:blocked");
            await addComment(result.issueNumber, `**Block reason:** Pre-merge verification failed — ${premerge.reason ?? "unknown"}`).catch((err) => log.warn({ err: String(err) }, "failed to post block comment"));
            continue;
          }
          try {
            const mergeResult = await mergeIssuePR(result.branch, {
              squash: config.squashMerge,
              deleteBranch: config.deleteBranchAfterMerge,
            });

            if (!mergeResult.success) {
              mergeConflicts++;
              log.warn(
                { issue: result.issueNumber, branch: result.branch, reason: mergeResult.reason },
                "PR merge failed — marking as failed",
              );
              result.status = "failed";
              result.qualityGatePassed = false;
              await setLabel(result.issueNumber, "status:blocked");
              await addComment(result.issueNumber, `**Block reason:** PR merge failed — ${mergeResult.reason ?? "unknown"}`).catch((err) => log.warn({ err: String(err), issue: result.issueNumber }, "failed to post block reason comment"));
            } else {
              log.info({ issue: result.issueNumber, branch: result.branch, pr: mergeResult.prNumber }, "PR merged");

              // Post-merge verification: run tests + types on main to catch combinatorial breakage
              try {
                const gateConfig = buildQualityGateConfig(config);
                const verifyResult = await verifyMainBranch(config.projectPath, gateConfig);
                if (!verifyResult.passed) {
                  const failedChecks = verifyResult.checks.filter((c) => !c.passed).map((c) => c.name).join(", ");
                  log.error({ issue: result.issueNumber, failedChecks }, "post-merge verification FAILED on main");
                  await escalateToStakeholder({
                    level: "must",
                    reason: `Post-merge verification failed after merging #${result.issueNumber}`,
                    detail: `Failed checks: ${failedChecks}. Main branch may be broken.`,
                    context: { issueNumber: result.issueNumber, branch: result.branch },
                    timestamp: new Date(),
                  }, { ntfyEnabled: !!config.ntfy?.enabled, ntfyTopic: config.ntfy?.topic }, eventBus);
                }
              } catch (verifyErr: unknown) {
                appendErrorLog("error", `post-merge verification FAILED — issue #${result.issueNumber}, halting merges`, { issue: result.issueNumber, err: String(verifyErr) });
                log.error({ err: verifyErr, issue: result.issueNumber }, "post-merge verification could not run — halting further merges");
                break;
              }
            }
          } catch (err: unknown) {
            mergeConflicts++;
            appendErrorLog("error", `merge error — issue #${result.issueNumber}`, { issue: result.issueNumber, err: String(err) });
            log.error({ issue: result.issueNumber, err }, "merge error");
            result.status = "failed";
            result.qualityGatePassed = false;
          }
        }
      } else {
        const issueNumber = group.issues[i];
        log.error({ issueNumber, err: outcome.reason }, "issue execution rejected");
        allResults.push({
          issueNumber,
          status: "failed",
          qualityGatePassed: false,
          qualityDetails: { passed: false, checks: [] },
          branch: config.branchPattern
            .replace("{prefix}", config.sprintSlug)
            .replace("{sprint}", String(config.sprintNumber))
            .replace("{issue}", String(issueNumber)),
          duration_ms: 0,
          filesChanged: [],
          retryCount: 0,
          points: issueMap.get(issueNumber)?.points ?? 0,
        });
      }
    }

    // Check for critical failures after group
    const groupResults = allResults.slice(-group.issues.length);
    const failures = groupResults.filter((r) => r.status === "failed");
    if (failures.length === group.issues.length && group.issues.length > 0) {
      log.warn(
        { group: group.group, failureCount: failures.length },
        "all issues in group failed — escalating to stakeholder",
      );

      // Escalate with ntfy notification
      const failedIssueNumbers = failures.map((f) => `#${f.issueNumber}`).join(", ");
      await escalateToStakeholder({
        level: "must",
        reason: `All issues in execution group ${group.group} failed`,
        detail: `Failed issues: ${failedIssueNumbers}. Sprint execution paused until stakeholder intervenes. Unblock issues and resume to retry.`,
        context: { group: group.group, failures: failures.length },
        timestamp: new Date(),
      }, { ntfyEnabled: !!config.ntfy?.enabled, ntfyTopic: config.ntfy?.topic }, eventBus);

      // Emit event so runner can handle pause
      eventBus?.emitTyped("sprint:error", {
        error: `All ${failures.length} issues in group ${group.group} failed. Execution paused — waiting for stakeholder.`,
      });

      break;
    }
  }

  const totalGroupSize = groups.reduce((sum, g) => sum + g.issues.length, 0);
  const parallelizationRatio =
    groups.length > 0 ? totalGroupSize / groups.length : 1;

  const durations = allResults.map((r) => r.duration_ms);
  const avgWorktreeLifetime =
    durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;

  return {
    results: allResults,
    sprint: plan.sprintNumber,
    parallelizationRatio,
    avgWorktreeLifetime,
    mergeConflicts,
  };
}
