/**
 * Config Validator — validates .aiscrum/ configuration for correctness.
 *
 * Runs automated checks that catch common configuration issues:
 * - Missing instruction/prompt files
 * - Tool policy misalignment (instructions reference blocked capabilities)
 * - Missing ceremony phase definitions
 * - Cross-cutting consistency (Stakeholder Authority, repo identifiers)
 * - Template variable mismatches
 * - Ghost file references
 */

import fs from "node:fs";
import path from "node:path";
import type { ConfigFile } from "../config.js";
import { PRESET_CAPABILITIES } from "../types/config.js";
import { logger } from "../logger.js";

export interface ValidationIssue {
  check: string;
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  passed: number;
  failed: number;
  warnings: number;
}

/** All ceremony phase keys used by the sprint runner code. */
const CEREMONY_PHASES = [
  "planner",
  "planning",
  "worker",
  "reviewer",
  "review",
  "refinement",
  "retro",
  "challenger",
  "test-engineer",
  "conflict-resolver",
] as const;

/**
 * Known role directories and their expected prompt template files.
 * Maps phase key → { roleDir, promptFile? }.
 */
const PHASE_ROLE_MAP: Record<string, { roleDir: string; promptFile?: string }> = {
  planner: { roleDir: "planner", promptFile: "item-planner.md" },
  planning: { roleDir: "planner", promptFile: "planning.md" },
  worker: { roleDir: "general", promptFile: "worker.md" },
  reviewer: { roleDir: "reviewer" }, // code review uses inline prompt
  review: { roleDir: "reviewer", promptFile: "review.md" },
  refinement: { roleDir: "refiner", promptFile: "refinement.md" },
  retro: { roleDir: "retro", promptFile: "retro.md" },
  challenger: { roleDir: "challenger" }, // uses inline prompt
  "test-engineer": { roleDir: "test-engineer", promptFile: "tdd.md" },
  "conflict-resolver": { roleDir: "conflict-resolver" }, // uses inline prompt
  "quality-reviewer": { roleDir: "quality-reviewer", promptFile: "acceptance-review.md" },
};

/**
 * Template variables provided by each ceremony in the sprint runner.
 * Maps phase → set of variable names that substitutePrompt receives.
 */
const PROVIDED_VARIABLES: Record<string, Set<string>> = {
  planner: new Set([
    "PROJECT_NAME",
    "REPO_OWNER",
    "REPO_NAME",
    "SPRINT_NUMBER",
    "ISSUE_NUMBER",
    "ISSUE_TITLE",
    "ISSUE_BODY",
    "BRANCH_NAME",
    "BASE_BRANCH",
    "WORKTREE_PATH",
    "MAX_DIFF_LINES",
  ]),
  planning: new Set([
    "PROJECT_NAME",
    "REPO_OWNER",
    "REPO_NAME",
    "SPRINT_NUMBER",
    "MIN_ISSUES",
    "MAX_ISSUES",
    "BASE_BRANCH",
  ]),
  worker: new Set([
    "PROJECT_NAME",
    "REPO_OWNER",
    "REPO_NAME",
    "SPRINT_NUMBER",
    "ISSUE_NUMBER",
    "ISSUE_TITLE",
    "ISSUE_BODY",
    "BRANCH_NAME",
    "BASE_BRANCH",
    "WORKTREE_PATH",
    "MAX_DIFF_LINES",
  ]),
  review: new Set([
    "PROJECT_NAME",
    "REPO_OWNER",
    "REPO_NAME",
    "SPRINT_NUMBER",
    "SPRINT_START_SHA",
    "SPRINT_ISSUES",
    "BASE_BRANCH",
    "METRICS",
    "FAILED_GATES",
    "FLAGGED_PRS",
  ]),
  refinement: new Set(["PROJECT_NAME", "REPO_OWNER", "REPO_NAME", "SPRINT_NUMBER", "BASE_BRANCH"]),
  retro: new Set([
    "PROJECT_NAME",
    "REPO_OWNER",
    "REPO_NAME",
    "SPRINT_NUMBER",
    "SPRINT_REVIEW_DATA",
    "FAILURE_DIAGNOSTICS",
  ]),
  "test-engineer": new Set([
    "PROJECT_NAME",
    "REPO_OWNER",
    "REPO_NAME",
    "SPRINT_NUMBER",
    "ISSUE_NUMBER",
    "ISSUE_TITLE",
    "ISSUE_BODY",
    "BRANCH_NAME",
    "BASE_BRANCH",
    "WORKTREE_PATH",
    "MAX_DIFF_LINES",
    "IMPLEMENTATION_PLAN",
  ]),
  "quality-reviewer": new Set([
    "ISSUE_NUMBER",
    "ISSUE_TITLE",
    "ACCEPTANCE_CRITERIA",
    "DIFF",
    "TEST_OUTPUT",
    "QG_RESULT",
  ]),
};

/** Shell command patterns that require shell_execute capability. */
const SHELL_PATTERNS = [
  /^`gh\s/m,
  /^\s*gh\s+\w+/m,
  /^`git\s(?!hub)/m,
  /^`make\s/m,
  /^\s*make\s+\w+/m,
  /^`uv\s+run\s/m,
  /```bash\n/,
];

/** File edit patterns that require file_edit capability. */
const EDIT_PATTERNS = [/\bUpdate\b.*\bfile\b/i, /\bCreate the file\b/i];

/**
 * Run all validation checks on a project's .aiscrum/ configuration.
 */
export async function validateConfig(
  projectPath: string,
  config: ConfigFile,
): Promise<ValidationReport> {
  const log = logger.child({ module: "config-validator" });
  const issues: ValidationIssue[] = [];
  const rolesDir = path.join(projectPath, ".aiscrum", "roles");

  log.info({ projectPath }, "starting config validation");

  // Check 1: Instruction files exist
  checkInstructionFilesExist(projectPath, config, issues);

  // Check 2: Prompt template files exist
  checkPromptTemplatesExist(projectPath, issues);

  // Check 3: Phase coverage
  checkPhaseCoverage(config, issues);

  // Check 4: Tool policy alignment
  await checkToolPolicyAlignment(projectPath, config, issues);

  // Check 5: Stakeholder Authority in all roles
  checkStakeholderAuthority(rolesDir, issues);

  // Check 6: Template variable validation
  await checkTemplateVariables(projectPath, issues);

  // Check 7: Ghost file references
  await checkGhostReferences(projectPath, rolesDir, issues);

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const passed = 7 - (errors > 0 ? 1 : 0);

  log.info({ errors, warnings, total: issues.length }, "validation complete");

  return { issues, passed, failed: errors, warnings };
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkInstructionFilesExist(
  projectPath: string,
  config: ConfigFile,
  issues: ValidationIssue[],
): void {
  // Global instructions
  for (const instrPath of config.copilot.instructions) {
    const resolved = path.resolve(projectPath, instrPath);
    if (!fs.existsSync(resolved)) {
      issues.push({
        check: "files-exist",
        severity: "error",
        message: `Global instruction file not found: ${instrPath}`,
        file: instrPath,
      });
    }
  }

  // Phase-specific instructions
  for (const [phase, phaseConfig] of Object.entries(config.copilot.phases)) {
    for (const instrPath of phaseConfig.instructions ?? []) {
      const resolved = path.resolve(projectPath, instrPath);
      if (!fs.existsSync(resolved)) {
        issues.push({
          check: "files-exist",
          severity: "error",
          message: `Phase "${phase}" instruction file not found: ${instrPath}`,
          file: instrPath,
        });
      }
    }
  }
}

function checkPromptTemplatesExist(projectPath: string, issues: ValidationIssue[]): void {
  for (const [phase, mapping] of Object.entries(PHASE_ROLE_MAP)) {
    if (!mapping.promptFile) continue;

    const promptPath = path.join(
      projectPath,
      ".aiscrum",
      "roles",
      mapping.roleDir,
      "prompts",
      mapping.promptFile,
    );
    if (!fs.existsSync(promptPath)) {
      issues.push({
        check: "prompts-exist",
        severity: "error",
        message: `Prompt template for "${phase}" phase not found: roles/${mapping.roleDir}/prompts/${mapping.promptFile}`,
        file: promptPath,
      });
    }
  }
}

function checkPhaseCoverage(config: ConfigFile, issues: ValidationIssue[]): void {
  const configuredPhases = new Set(Object.keys(config.copilot.phases));

  for (const phase of CEREMONY_PHASES) {
    if (!configuredPhases.has(phase)) {
      issues.push({
        check: "phase-coverage",
        severity: "warning",
        message: `Ceremony phase "${phase}" is used by the sprint runner but not configured — will use defaults (no model, no instructions, no tool policy)`,
      });
    }
  }
}

async function checkToolPolicyAlignment(
  projectPath: string,
  config: ConfigFile,
  issues: ValidationIssue[],
): Promise<void> {
  for (const [phase, phaseConfig] of Object.entries(config.copilot.phases)) {
    if (!phaseConfig.tool_policy || typeof phaseConfig.tool_policy !== "string") continue;

    const capabilities = PRESET_CAPABILITIES[phaseConfig.tool_policy];
    if (!capabilities) continue;

    const hasShell = capabilities.includes("shell_execute");
    const hasEdit = capabilities.includes("file_edit");

    // Check instruction files for blocked capability references
    for (const instrPath of phaseConfig.instructions ?? []) {
      const resolved = path.resolve(projectPath, instrPath);
      if (!fs.existsSync(resolved)) continue;

      const content = fs.readFileSync(resolved, "utf-8");

      if (!hasShell) {
        for (const pattern of SHELL_PATTERNS) {
          if (pattern.test(content)) {
            issues.push({
              check: "tool-policy",
              severity: "warning",
              message: `Phase "${phase}" (${phaseConfig.tool_policy}) blocks shell_execute but instruction file references shell commands`,
              file: instrPath,
            });
            break;
          }
        }
      }

      if (!hasEdit) {
        for (const pattern of EDIT_PATTERNS) {
          if (pattern.test(content)) {
            issues.push({
              check: "tool-policy",
              severity: "warning",
              message: `Phase "${phase}" (${phaseConfig.tool_policy}) blocks file_edit but instruction file references file editing`,
              file: instrPath,
            });
            break;
          }
        }
      }
    }

    // Also check prompt templates for the same phase
    const mapping = PHASE_ROLE_MAP[phase];
    if (mapping?.promptFile) {
      const promptPath = path.join(
        projectPath,
        ".aiscrum",
        "roles",
        mapping.roleDir,
        "prompts",
        mapping.promptFile,
      );
      if (fs.existsSync(promptPath)) {
        const content = fs.readFileSync(promptPath, "utf-8");

        if (!hasShell) {
          for (const pattern of SHELL_PATTERNS) {
            if (pattern.test(content)) {
              issues.push({
                check: "tool-policy",
                severity: "warning",
                message: `Phase "${phase}" (${phaseConfig.tool_policy}) blocks shell_execute but prompt template references shell commands`,
                file: `roles/${mapping.roleDir}/prompts/${mapping.promptFile}`,
              });
              break;
            }
          }
        }

        if (!hasEdit) {
          for (const pattern of EDIT_PATTERNS) {
            if (pattern.test(content)) {
              issues.push({
                check: "tool-policy",
                severity: "warning",
                message: `Phase "${phase}" (${phaseConfig.tool_policy}) blocks file_edit but prompt template references file editing`,
                file: `roles/${mapping.roleDir}/prompts/${mapping.promptFile}`,
              });
              break;
            }
          }
        }
      }
    }
  }
}

function checkStakeholderAuthority(rolesDir: string, issues: ValidationIssue[]): void {
  if (!fs.existsSync(rolesDir)) return;

  const roleDirs = fs
    .readdirSync(rolesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const role of roleDirs) {
    const instrPath = path.join(rolesDir, role, "copilot-instructions.md");
    if (!fs.existsSync(instrPath)) continue;

    const content = fs.readFileSync(instrPath, "utf-8");
    if (!content.includes("Stakeholder Authority")) {
      issues.push({
        check: "stakeholder-authority",
        severity: "warning",
        message: `Role "${role}" copilot-instructions.md missing Stakeholder Authority section`,
        file: `roles/${role}/copilot-instructions.md`,
      });
    }
  }
}

async function checkTemplateVariables(
  projectPath: string,
  issues: ValidationIssue[],
): Promise<void> {
  for (const [phase, providedVars] of Object.entries(PROVIDED_VARIABLES)) {
    const mapping = PHASE_ROLE_MAP[phase];
    if (!mapping?.promptFile) continue;

    const promptPath = path.join(
      projectPath,
      ".aiscrum",
      "roles",
      mapping.roleDir,
      "prompts",
      mapping.promptFile,
    );
    if (!fs.existsSync(promptPath)) continue;

    const content = fs.readFileSync(promptPath, "utf-8");
    const usedVars = new Set([...content.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]!));

    for (const varName of usedVars) {
      if (!providedVars.has(varName)) {
        issues.push({
          check: "template-vars",
          severity: "error",
          message: `Prompt "${mapping.promptFile}" uses {{${varName}}} but phase "${phase}" does not provide it — will appear as literal text`,
          file: `roles/${mapping.roleDir}/prompts/${mapping.promptFile}`,
        });
      }
    }
  }
}

async function checkGhostReferences(
  projectPath: string,
  rolesDir: string,
  issues: ValidationIssue[],
): Promise<void> {
  if (!fs.existsSync(rolesDir)) return;

  const mdFiles = findMdFiles(rolesDir);

  for (const mdFile of mdFiles) {
    const content = fs.readFileSync(mdFile, "utf-8");
    const relPath = path.relative(projectPath, mdFile);

    // Find references to .aiscrum/ files
    const refs = [...content.matchAll(/\.aiscrum\/[^\s`"')]+\.(?:yaml|md|json)/g)];
    for (const ref of refs) {
      const refPath = path.resolve(projectPath, ref[0]);
      if (!fs.existsSync(refPath)) {
        issues.push({
          check: "ghost-refs",
          severity: "warning",
          message: `References non-existent file: ${ref[0]}`,
          file: relPath,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findMdFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "log") {
      results.push(...findMdFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Format validation report for terminal output.
 */
export function formatReport(report: ValidationReport): string {
  const lines: string[] = [];

  lines.push("━━━ Config Validation Report ━━━");
  lines.push("");

  if (report.issues.length === 0) {
    lines.push("✅ All checks passed — no issues found");
    return lines.join("\n");
  }

  // Group by check
  const grouped = new Map<string, ValidationIssue[]>();
  for (const issue of report.issues) {
    const existing = grouped.get(issue.check) ?? [];
    existing.push(issue);
    grouped.set(issue.check, existing);
  }

  for (const [check, checkIssues] of grouped) {
    const icon = checkIssues.some((i) => i.severity === "error")
      ? "❌"
      : checkIssues.some((i) => i.severity === "warning")
        ? "⚠️"
        : "ℹ️";
    lines.push(
      `${icon} ${check} (${checkIssues.length} issue${checkIssues.length > 1 ? "s" : ""})`,
    );
    for (const issue of checkIssues) {
      const severity =
        issue.severity === "error" ? "ERROR" : issue.severity === "warning" ? "WARN" : "INFO";
      const fileRef = issue.file ? ` [${issue.file}]` : "";
      lines.push(`  ${severity}: ${issue.message}${fileRef}`);
    }
    lines.push("");
  }

  const errors = report.issues.filter((i) => i.severity === "error").length;
  const warnings = report.issues.filter((i) => i.severity === "warning").length;
  lines.push(`━━━ ${errors} errors, ${warnings} warnings ━━━`);

  return lines.join("\n");
}
