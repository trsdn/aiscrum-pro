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

export interface PhaseConfig {
  model?: string;
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
  autoRevertDrift: boolean;
  backlogLabels: string[];
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
