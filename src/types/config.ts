// --- MCP Server Configuration (matches ACP SDK McpServer types) ---

export interface McpServerStdio {
  type: "stdio";
  name: string;
  command: string;
  args: string[];
  env?: Array<{ name: string; value: string }>;
}

export interface McpServerHttp {
  type: "http";
  name: string;
  url: string;
  headers?: Array<{ name: string; value: string }>;
}

export interface McpServerSse {
  type: "sse";
  name: string;
  url: string;
  headers?: Array<{ name: string; value: string }>;
}

export type McpServerEntry = McpServerStdio | McpServerHttp | McpServerSse;

// --- Phase Configuration ---

/** Tool capability that can be granted to a phase. */
export type ToolCapability =
  | "codebase_read"
  | "file_edit"
  | "file_create"
  | "shell_execute"
  | "github_read"
  | "github_write";

/** Tool name patterns mapped to each capability. */
export const CAPABILITY_PATTERNS: Record<ToolCapability, string[]> = {
  codebase_read: ["view", "grep", "glob"],
  file_edit: ["edit"],
  file_create: ["create"],
  shell_execute: ["bash", "write_bash", "read_bash", "stop_bash", "list_bash"],
  github_read: [
    "github-mcp-server-issue_read",
    "github-mcp-server-pull_request_read",
    "github-mcp-server-list_",
    "github-mcp-server-search_",
    "github-mcp-server-get_",
    "github-mcp-server-actions_",
  ],
  github_write: [
    "github-mcp-server-create_",
    "github-mcp-server-update_",
    "github-mcp-server-add_",
    "github-mcp-server-merge_",
    "github-mcp-server-push_",
    "github-mcp-server-delete_",
    "github-mcp-server-fork_",
  ],
};

/** Preset → capability mapping. */
export const PRESET_CAPABILITIES: Record<string, ToolCapability[]> = {
  full: [
    "codebase_read",
    "file_edit",
    "file_create",
    "shell_execute",
    "github_read",
    "github_write",
  ],
  developer: ["codebase_read", "file_edit", "file_create", "shell_execute", "github_read"],
  verifier: ["codebase_read", "shell_execute", "github_read"],
  orchestrator: ["codebase_read", "github_read", "github_write"],
  author: ["codebase_read", "file_edit", "file_create", "github_read"],
  observer: ["codebase_read", "github_read"],
};

/** Resolved tool policy ready for the permission handler. */
export interface ResolvedToolPolicy {
  /** Flat list of tool-name patterns to allow. */
  allowPatterns: string[];
}

/** Resolve a tool_policy config value to a flat allow-pattern list. */
export function resolveToolPolicy(
  policy: string | { capabilities: ToolCapability[] },
): ResolvedToolPolicy {
  const capabilities: ToolCapability[] =
    typeof policy === "string"
      ? (PRESET_CAPABILITIES[policy] ?? PRESET_CAPABILITIES["full"]!)
      : policy.capabilities;

  const patterns = capabilities.flatMap((cap) => CAPABILITY_PATTERNS[cap] ?? []);
  return { allowPatterns: [...new Set(patterns)] };
}

export interface PhaseConfig {
  model?: string;
  thought_level?: "medium" | "high";
  tool_policy?: string | { capabilities: ToolCapability[] };
  mcp_servers: McpServerEntry[];
  instructions: string[];
}

// --- Sub-config groupings ---

export interface GitConfig {
  baseBranch: string;
  branchPattern: string;
  worktreeBase: string;
  autoMerge: boolean;
  squashMerge: boolean;
  deleteBranchAfterMerge: boolean;
}

export interface SessionConfig {
  maxParallelSessions: number;
  sessionTimeoutMs: number;
  customInstructions: string;
  autoApproveTools: boolean;
  allowToolPatterns: string[];
  globalMcpServers: McpServerEntry[];
  globalInstructions: string[];
  phases: Record<string, PhaseConfig>;
}

export interface ExecutionLimits {
  minIssuesPerSprint: number;
  maxIssuesPerSprint: number;
  maxIssuesCreatedPerSprint?: number;
  maxRetries: number;
  maxDriftIncidents: number;
  enableChallenger: boolean;
  enableTdd: boolean;
  sequentialExecution: boolean;
  autoRevertDrift: boolean;
  backlogLabels: string[];
}

export interface CustomGateSetting {
  name: string;
  command: string | string[];
  required: boolean;
  category:
    | "lint"
    | "test"
    | "type"
    | "build"
    | "diff"
    | "security"
    | "format"
    | "domain"
    | "custom";
}

export interface QualityGateSettings {
  requireTests: boolean;
  requireLint: boolean;
  requireTypes: boolean;
  requireBuild: boolean;
  maxDiffLines: number;
  testCommand: string | string[];
  lintCommand: string | string[];
  typecheckCommand: string | string[];
  buildCommand: string | string[];
  customGates?: CustomGateSetting[];
}

// --- Configuration ---

export interface SprintConfig extends GitConfig, SessionConfig, ExecutionLimits {
  sprintNumber: number;
  sprintPrefix: string;
  sprintSlug: string;
  projectPath: string;
  /** GitHub repository owner (org or user), derived from git remote. */
  repoOwner: string;
  /** GitHub repository name, derived from git remote. */
  repoName: string;
  /** Quality gate settings from YAML config. Falls back to hardcoded defaults when absent. */
  qualityGate?: QualityGateSettings;
  /** ntfy push notification settings. */
  ntfy?: {
    enabled: boolean;
    topic: string;
    serverUrl?: string;
  };
}
