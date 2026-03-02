// Config loader: parse sprint-runner.config.yaml with Zod validation

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// --- Zod Schemas ---

const NameValueSchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
});

const McpServerStdioSchema = z.object({
  type: z.literal("stdio"),
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.array(NameValueSchema).optional(),
});

const McpServerHttpSchema = z.object({
  type: z.literal("http"),
  name: z.string().min(1),
  url: z.string().url(),
  headers: z.array(NameValueSchema).optional(),
});

const McpServerSseSchema = z.object({
  type: z.literal("sse"),
  name: z.string().min(1),
  url: z.string().url(),
  headers: z.array(NameValueSchema).optional(),
});

const McpServerEntrySchema = z.discriminatedUnion("type", [
  McpServerStdioSchema,
  McpServerHttpSchema,
  McpServerSseSchema,
]);

const PhaseConfigSchema = z.object({
  model: z.string().optional(),
  mcp_servers: z.array(McpServerEntrySchema).default([]),
  instructions: z.array(z.string()).default([]),
});

const ProjectSchema = z.object({
  name: z.string().min(1),
  base_branch: z.string().min(1).default("main"),
});

const CopilotSchema = z.object({
  executable: z.string().min(1).default("copilot"),
  max_parallel_sessions: z.number().int().min(1).max(20).default(4),
  session_timeout_ms: z.number().int().min(0).default(600000),
  auto_approve_tools: z.boolean().default(true),
  allow_tool_patterns: z.array(z.string()).default([]),
  mcp_servers: z.array(McpServerEntrySchema).default([]),
  instructions: z.array(z.string()).default([]),
  phases: z.record(z.string(), PhaseConfigSchema).default({}),
});

const SprintSchema = z.object({
  prefix: z.string().min(1).default("Sprint"),
  max_issues: z.number().int().min(1).default(8),
  max_issues_created_per_sprint: z.number().int().min(1).default(10),
  max_sprints: z.number().int().min(0).default(0), // 0 = infinite
  max_drift_incidents: z.number().int().min(0).default(2),
  max_retries: z.number().int().min(0).default(2),
  enable_challenger: z.boolean().default(true),
  enable_tdd: z.boolean().default(false),
  auto_revert_drift: z.boolean().default(false),
  backlog_labels: z.array(z.string()).default([]),
});

const QualityGatesSchema = z.object({
  require_tests: z.boolean().default(true),
  require_lint: z.boolean().default(true),
  require_types: z.boolean().default(true),
  require_build: z.boolean().default(true),
  max_diff_lines: z.number().int().min(1).default(300),
  test_command: z.union([z.string(), z.array(z.string())]).default(["npm", "run", "test"]),
  lint_command: z.union([z.string(), z.array(z.string())]).default(["npm", "run", "lint"]),
  typecheck_command: z.union([z.string(), z.array(z.string())]).default(["npm", "run", "typecheck"]),
  build_command: z.union([z.string(), z.array(z.string())]).default(["npm", "run", "build"]),
  require_challenger: z.boolean().default(true),
});

const EscalationSchema = z
  .object({
    notifications: z
      .object({
        ntfy: z.boolean().default(false),
        ntfy_topic: z.string().default(""),
        ntfy_server_url: z.string().url().default("https://ntfy.sh"),
      })
      .default({}),
  })
  .refine(
    (cfg) => !cfg.notifications.ntfy || cfg.notifications.ntfy_topic.length > 0,
    { message: "ntfy_topic must be non-empty when ntfy notifications are enabled" },
  );

const GitSchema = z.object({
  worktree_base: z.string().min(1).default("../sprint-worktrees"),
  branch_pattern: z
    .string()
    .min(1)
    .default("{prefix}/{sprint}/issue-{issue}")
    .refine(
      (p) => p.includes("{issue}"),
      { message: "branch_pattern must contain {issue} placeholder" },
    ),
  auto_merge: z.boolean().default(true),
  squash_merge: z.boolean().default(true),
  delete_branch_after_merge: z.boolean().default(true),
});

const GitHubSchema = z.object({}).default({});

export const ConfigFileSchema = z.object({
  project: ProjectSchema,
  copilot: CopilotSchema.default({}),
  sprint: SprintSchema.default({}),
  quality_gates: QualityGatesSchema.default({}),
  escalation: EscalationSchema.default({}),
  git: GitSchema.default({}),
  github: GitHubSchema.default({}),
});

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

// --- Sprint prefix utilities ---

/** Convert a sprint prefix to a file-system-safe slug (e.g. "Test Sprint" → "test-sprint"). */
export function prefixToSlug(prefix: string): string {
  return prefix.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

// --- Environment variable substitution ---

/** Replace `${VAR}` placeholders with values from process.env */
export function substituteEnvVars(text: string): string {
  return text.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const value = process.env[varName];
    if (value === undefined) {
      return "";
    }
    return value;
  });
}

// --- Loader ---

/**
 * Load and validate sprint-runner.config.yaml.
 * @param configPath – absolute or relative path to YAML config file.
 *   Defaults to `sprint-runner.config.yaml` in the current working directory.
 */
export function loadConfig(configPath?: string): ConfigFile {
  const resolvedPath = path.resolve(
    configPath ?? "sprint-runner.config.yaml",
  );

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Config file not found: ${resolvedPath}`);
  }

  const raw = fs.readFileSync(resolvedPath, "utf-8");
  const substituted = substituteEnvVars(raw);
  const parsed: unknown = parseYaml(substituted, { customTags: [] });

  return ConfigFileSchema.parse(parsed);
}
