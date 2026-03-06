import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { glob } from "glob";
import { diffStat } from "../git/diff-analysis.js";
import { logger } from "../logger.js";
import type { QualityCheck, QualityResult } from "../types.js";

const execFile = promisify(execFileCb);

export interface CustomGateEntry {
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

export interface QualityGateConfig {
  requireTests: boolean;
  requireLint: boolean;
  requireTypes: boolean;
  requireBuild: boolean;
  maxDiffLines: number;
  testCommand: string | string[];
  lintCommand: string | string[];
  typecheckCommand: string | string[];
  buildCommand: string | string[];
  expectedFiles?: string[];
  customGates?: CustomGateEntry[];
}

/** Normalize a command to an array, logging a warning for legacy string usage. */
function normalizeCommand(command: string | string[]): string[] {
  if (Array.isArray(command)) {
    if (command.length === 0) {
      throw new Error("Command array cannot be empty");
    }
    return command;
  }
  const log = logger.child({ module: "quality-gate" });
  log.warn(
    { command },
    "Command passed as string — splitting on spaces as fallback. Prefer string[] to support paths with spaces.",
  );
  const parts = command.split(" ");
  if (parts.length === 0 || parts[0] === "") {
    throw new Error("Command string cannot be empty");
  }
  return parts;
}

async function runCommand(
  command: string | string[],
  cwd: string,
): Promise<{ ok: boolean; output: string }> {
  const parts = normalizeCommand(command);
  const [cmd, ...args] = parts;
  try {
    const { stdout, stderr } = await execFile(cmd!, args, { cwd });
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, output: msg };
  }
}

export async function runQualityGate(
  config: QualityGateConfig,
  worktreePath: string,
  branch: string,
  baseBranch: string,
): Promise<QualityResult> {
  const log = logger.child({ module: "quality-gate" });
  const checks: QualityCheck[] = [];

  // 1. Check tests exist
  if (config.requireTests) {
    try {
      const testFiles = await glob("**/*.test.{ts,js,tsx,jsx}", {
        cwd: worktreePath,
        ignore: ["node_modules/**"],
      });
      checks.push({
        name: "tests-exist",
        passed: testFiles.length > 0,
        detail:
          testFiles.length > 0 ? `Found ${testFiles.length} test file(s)` : "No test files found",
        category: "test",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ error: msg }, "glob() failed in tests-exist check");
      checks.push({
        name: "tests-exist",
        passed: false,
        detail: `glob error: ${msg}`,
        category: "test",
      });
    }
  }

  // 2. Check tests pass
  if (config.requireTests) {
    const result = await runCommand(config.testCommand, worktreePath);
    checks.push({
      name: "tests-pass",
      passed: result.ok,
      detail: result.ok ? "Tests passed" : result.output,
      category: "test",
    });
  }

  // 3. Check lint clean
  if (config.requireLint) {
    const result = await runCommand(config.lintCommand, worktreePath);
    checks.push({
      name: "lint-clean",
      passed: result.ok,
      detail: result.ok ? "Lint clean" : result.output,
      category: "lint",
    });
  }

  // 4. Check types clean
  if (config.requireTypes) {
    const result = await runCommand(config.typecheckCommand, worktreePath);
    checks.push({
      name: "types-clean",
      passed: result.ok,
      detail: result.ok ? "Types clean" : result.output,
      category: "type",
    });
  }

  // 5. Check build succeeds
  if (config.requireBuild) {
    const result = await runCommand(config.buildCommand, worktreePath);
    checks.push({
      name: "build-pass",
      passed: result.ok,
      detail: result.ok ? "Build succeeded" : result.output,
      category: "build",
    });
  }

  // 6. Run custom gates
  if (config.customGates && config.customGates.length > 0) {
    for (const gate of config.customGates) {
      const result = await runCommand(gate.command, worktreePath);
      checks.push({
        name: gate.name,
        passed: gate.required ? result.ok : true,
        detail: result.ok
          ? `${gate.name} passed`
          : `${gate.name} failed${gate.required ? "" : " (advisory)"}${result.output ? `: ${result.output}` : ""}`,
        category: gate.category,
      });
      if (!result.ok && !gate.required) {
        log.warn({ gate: gate.name }, "advisory gate failed (non-blocking)");
      }
    }
  }

  // 7. Compute diff stat for diff-size check
  try {
    const stat = await diffStat(branch, baseBranch);

    // 8. Check diff size
    const diffPassed = stat.linesChanged <= config.maxDiffLines;
    checks.push({
      name: "diff-size",
      passed: diffPassed,
      detail: diffPassed
        ? `${stat.linesChanged} lines changed (max ${config.maxDiffLines})`
        : `${stat.linesChanged} lines changed exceeds max ${config.maxDiffLines}`,
      category: "diff",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ error: msg }, "diffStat() failed — skipping diff-size check");
    checks.push({
      name: "diff-stat",
      passed: false,
      detail: `diffStat error: ${msg}`,
      category: "diff",
    });
  }

  const passed = checks.every((c) => c.passed);

  log.info(
    { passed, totalChecks: checks.length, failed: checks.filter((c) => !c.passed).length },
    "quality gate %s",
    passed ? "passed" : "failed",
  );

  return { passed, checks };
}

/**
 * Lightweight post-merge verification: pull latest main and run tests + types.
 * Used after squash-merge to catch combinatorial breakage on main.
 */
export async function verifyMainBranch(
  projectPath: string,
  config: Pick<QualityGateConfig, "testCommand" | "typecheckCommand">,
): Promise<QualityResult> {
  const log = logger.child({ module: "post-merge-verify" });
  const checks: QualityCheck[] = [];

  // Pull latest main
  try {
    await execFile("git", ["pull", "--rebase"], { cwd: projectPath });
  } catch {
    log.debug("git pull failed — proceeding with local state");
  }

  // Run tests
  const testResult = await runCommand(config.testCommand, projectPath);
  checks.push({
    name: "post-merge-tests",
    passed: testResult.ok,
    detail: testResult.ok ? "Tests pass on main" : testResult.output,
    category: "test",
  });

  // Run type check
  const typeResult = await runCommand(config.typecheckCommand, projectPath);
  checks.push({
    name: "post-merge-types",
    passed: typeResult.ok,
    detail: typeResult.ok ? "Types clean on main" : typeResult.output,
    category: "type",
  });

  const passed = checks.every((c) => c.passed);
  log.info({ passed }, "post-merge verification %s", passed ? "passed" : "FAILED");

  return { passed, checks };
}
