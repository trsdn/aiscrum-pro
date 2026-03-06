/**
 * Shared CLI helper functions — config builders, client factory, argument parsers.
 */

import { execFileSync } from "node:child_process";
import { InvalidArgumentError } from "commander";
import { loadConfig, type ConfigFile, prefixToSlug } from "../config.js";
import { AcpClient } from "../acp/client.js";
import type { SprintConfig } from "../types.js";

/** Parse owner/name from a git remote URL (HTTPS or SSH). */
function parseGitRemote(cwd: string): { owner: string; name: string } {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf-8",
    }).trim();
    // HTTPS: https://github.com/owner/repo.git
    // SSH:   git@github.com:owner/repo.git
    const match = url.match(/[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (match) return { owner: match[1]!, name: match[2]! };
  } catch {
    /* ignore — return empty */
  }
  return { owner: "", name: "" };
}

/** Build a SprintConfig from the parsed config file and a sprint number. */
export function buildSprintConfig(config: ConfigFile, sprintNumber: number): SprintConfig {
  const prefix = config.sprint.prefix;
  const slug = prefixToSlug(prefix);
  const cwd = process.cwd();
  const remote = parseGitRemote(cwd);
  return {
    sprintNumber,
    sprintPrefix: prefix,
    sprintSlug: slug,
    projectPath: cwd,
    repoOwner: remote.owner,
    repoName: remote.name || config.project.name,
    baseBranch: config.project.base_branch,
    worktreeBase: config.git.worktree_base,
    branchPattern: config.git.branch_pattern,
    maxParallelSessions: config.copilot.max_parallel_sessions,
    minIssuesPerSprint: config.sprint.min_issues,
    maxIssuesPerSprint: config.sprint.max_issues,
    maxDriftIncidents: config.sprint.max_drift_incidents,
    maxRetries: config.sprint.max_retries,
    enableChallenger: config.sprint.enable_challenger,
    enableTdd: config.sprint.enable_tdd,
    sequentialExecution: config.sprint.sequential_execution,
    autoRevertDrift: config.sprint.auto_revert_drift,
    backlogLabels: config.sprint.backlog_labels,
    autoMerge: config.git.auto_merge,
    squashMerge: config.git.squash_merge,
    deleteBranchAfterMerge: config.git.delete_branch_after_merge,
    sessionTimeoutMs: config.copilot.session_timeout_ms,
    customInstructions: "",
    autoApproveTools: config.copilot.auto_approve_tools,
    allowToolPatterns: config.copilot.allow_tool_patterns,
    globalMcpServers: config.copilot.mcp_servers,
    globalInstructions: config.copilot.instructions,
    phases: config.copilot.phases,
    qualityGate: {
      requireTests: config.quality_gates.require_tests,
      requireLint: config.quality_gates.require_lint,
      requireTypes: config.quality_gates.require_types,
      requireBuild: config.quality_gates.require_build,
      maxDiffLines: config.quality_gates.max_diff_lines,
      testCommand: config.quality_gates.test_command,
      lintCommand: config.quality_gates.lint_command,
      typecheckCommand: config.quality_gates.typecheck_command,
      buildCommand: config.quality_gates.build_command,
      customGates: config.quality_gates.custom_gates,
    },
    ntfy: {
      enabled: config.escalation.notifications.ntfy,
      topic: config.escalation.notifications.ntfy_topic,
      serverUrl: config.escalation.notifications.ntfy_server_url,
    },
  };
}

/** Create and connect an AcpClient using config settings. */
export async function createConnectedClient(config: ConfigFile): Promise<AcpClient> {
  const client = new AcpClient({
    command: config.copilot.executable,
    timeoutMs: config.copilot.session_timeout_ms,
    permissions: {
      autoApprove: config.copilot.auto_approve_tools,
      allowPatterns: config.copilot.allow_tool_patterns,
    },
  });
  await client.connect();
  return client;
}

/** Load config from the global --config option. */
export function loadConfigFromOpts(configPath?: string): ConfigFile {
  return loadConfig(configPath);
}

/** Parse and validate a sprint number from CLI input. */
export function parseSprintNumber(value: string): number {
  const num = parseInt(value, 10);
  if (isNaN(num) || num < 1) {
    throw new InvalidArgumentError("Sprint number must be a positive integer.");
  }
  return num;
}

/** Parse and validate an issue number from CLI input. */
export function parseIssueNumber(value: string): number {
  const num = parseInt(value, 10);
  if (isNaN(num) || num < 1) {
    throw new InvalidArgumentError("Issue number must be a positive integer.");
  }
  return num;
}
