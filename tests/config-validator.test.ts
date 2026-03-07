import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateConfig, formatReport } from "../src/validation/config-validator.js";
import type { ConfigFile } from "../src/config.js";

/** Minimal valid config for testing. */
function baseConfig(): ConfigFile {
  return {
    project: { name: "test-project", base_branch: "main" },
    copilot: {
      executable: "copilot",
      max_parallel_sessions: 1,
      session_timeout_ms: 60000,
      auto_approve_tools: true,
      allow_tool_patterns: [],
      mcp_servers: [],
      instructions: [],
      phases: {},
    },
    sprint: {
      prefix: "Sprint",
      min_issues: 1,
      max_issues: 5,
      max_issues_created_per_sprint: 5,
      max_sprints: 0,
      max_drift_incidents: 2,
      max_retries: 1,
      enable_challenger: false,
      enable_tdd: false,
      auto_revert_drift: false,
      sequential_execution: true,
      backlog_labels: [],
    },
    quality_gates: {
      require_tests: true,
      require_lint: true,
      require_types: true,
      require_build: false,
      max_diff_lines: 500,
      test_command: ["echo", "test"],
      lint_command: ["echo", "lint"],
      typecheck_command: ["echo", "types"],
      build_command: ["echo", "build"],
      custom_gates: [],
    },
    escalation: {
      notifications: { ntfy: false, ntfy_topic: "", ntfy_server_url: "https://ntfy.sh" },
    },
    git: {
      worktree_base: "../sprint-worktrees",
      branch_pattern: "{prefix}/{sprint}/issue-{issue}",
      auto_merge: true,
      squash_merge: true,
      delete_branch_after_merge: true,
    },
    github: {},
    heartbeat: { interval_ms: 30000, file: ".aiscrum/heartbeat.json" },
  } as unknown as ConfigFile;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aiscrum-validate-"));
  fs.mkdirSync(path.join(tmpDir, ".aiscrum", "roles"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("config-validator", () => {
  describe("files-exist", () => {
    it("reports missing global instruction files", async () => {
      const config = baseConfig();
      config.copilot.instructions = [".aiscrum/roles/general/skills/missing/SKILL.md"];

      const report = await validateConfig(tmpDir, config);
      const issue = report.issues.find((i) => i.check === "files-exist");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("error");
      expect(issue!.message).toContain("Global instruction file not found");
    });

    it("reports missing phase instruction files", async () => {
      const config = baseConfig();
      config.copilot.phases = {
        worker: {
          model: "test-model",
          mcp_servers: [],
          instructions: [".aiscrum/roles/general/missing.md"],
        },
      };

      const report = await validateConfig(tmpDir, config);
      const issue = report.issues.find((i) => i.check === "files-exist");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("error");
      expect(issue!.message).toContain("worker");
    });

    it("passes when all files exist", async () => {
      const config = baseConfig();
      const instrPath = ".aiscrum/roles/general/copilot-instructions.md";
      const fullPath = path.join(tmpDir, instrPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, "# Test\n\n## Stakeholder Authority\nDon't change scope.");
      config.copilot.instructions = [instrPath];

      const report = await validateConfig(tmpDir, config);
      const fileIssues = report.issues.filter((i) => i.check === "files-exist");
      expect(fileIssues).toHaveLength(0);
    });
  });

  describe("phase-coverage", () => {
    it("warns about missing ceremony phases", async () => {
      const config = baseConfig();
      // Empty phases — all ceremony phases missing
      const report = await validateConfig(tmpDir, config);
      const phaseIssues = report.issues.filter((i) => i.check === "phase-coverage");
      expect(phaseIssues.length).toBeGreaterThan(0);
      expect(phaseIssues[0]!.severity).toBe("warning");
      expect(phaseIssues[0]!.message).toContain("not configured");
    });

    it("passes when all phases are configured", async () => {
      const config = baseConfig();
      for (const phase of [
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
      ]) {
        config.copilot.phases[phase] = { mcp_servers: [], instructions: [] };
      }

      const report = await validateConfig(tmpDir, config);
      const phaseIssues = report.issues.filter((i) => i.check === "phase-coverage");
      expect(phaseIssues).toHaveLength(0);
    });
  });

  describe("stakeholder-authority", () => {
    it("warns when copilot-instructions.md lacks Stakeholder Authority", async () => {
      const roleDir = path.join(tmpDir, ".aiscrum", "roles", "general");
      fs.mkdirSync(roleDir, { recursive: true });
      fs.writeFileSync(path.join(roleDir, "copilot-instructions.md"), "# Worker\nNo authority.");

      const report = await validateConfig(tmpDir, baseConfig());
      const saIssues = report.issues.filter((i) => i.check === "stakeholder-authority");
      expect(saIssues).toHaveLength(1);
      expect(saIssues[0]!.message).toContain("general");
    });

    it("passes when Stakeholder Authority is present", async () => {
      const roleDir = path.join(tmpDir, ".aiscrum", "roles", "general");
      fs.mkdirSync(roleDir, { recursive: true });
      fs.writeFileSync(
        path.join(roleDir, "copilot-instructions.md"),
        "# Worker\n\n## Stakeholder Authority\nDon't change scope.",
      );

      const report = await validateConfig(tmpDir, baseConfig());
      const saIssues = report.issues.filter((i) => i.check === "stakeholder-authority");
      expect(saIssues).toHaveLength(0);
    });
  });

  describe("template-vars", () => {
    it("reports unsubstituted template variables", async () => {
      // Create a planning prompt with a variable the sprint runner doesn't provide
      const promptDir = path.join(tmpDir, ".aiscrum", "roles", "planner", "prompts");
      fs.mkdirSync(promptDir, { recursive: true });
      fs.writeFileSync(
        path.join(promptDir, "planning.md"),
        "Sprint {{SPRINT_NUMBER}} uses {{NONEXISTENT_VAR}}",
      );

      const report = await validateConfig(tmpDir, baseConfig());
      const varIssues = report.issues.filter((i) => i.check === "template-vars");
      expect(varIssues).toHaveLength(1);
      expect(varIssues[0]!.message).toContain("NONEXISTENT_VAR");
      expect(varIssues[0]!.severity).toBe("error");
    });

    it("passes when all variables are provided", async () => {
      const promptDir = path.join(tmpDir, ".aiscrum", "roles", "planner", "prompts");
      fs.mkdirSync(promptDir, { recursive: true });
      fs.writeFileSync(
        path.join(promptDir, "planning.md"),
        "Sprint {{SPRINT_NUMBER}} for {{PROJECT_NAME}}",
      );

      const report = await validateConfig(tmpDir, baseConfig());
      const varIssues = report.issues.filter((i) => i.check === "template-vars");
      expect(varIssues).toHaveLength(0);
    });
  });

  describe("tool-policy", () => {
    it("warns when orchestrator instructions reference shell commands", async () => {
      const config = baseConfig();
      const instrPath = ".aiscrum/roles/planner/copilot-instructions.md";
      const fullPath = path.join(tmpDir, instrPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, "## Stakeholder Authority\nRun:\n```bash\nmake check\n```\n");
      config.copilot.phases = {
        planner: {
          tool_policy: "orchestrator",
          mcp_servers: [],
          instructions: [instrPath],
        },
      };

      const report = await validateConfig(tmpDir, config);
      const policyIssues = report.issues.filter((i) => i.check === "tool-policy");
      expect(policyIssues.length).toBeGreaterThan(0);
      expect(policyIssues[0]!.message).toContain("shell_execute");
    });

    it("does not warn for full tool policy", async () => {
      const config = baseConfig();
      const instrPath = ".aiscrum/roles/general/copilot-instructions.md";
      const fullPath = path.join(tmpDir, instrPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, "## Stakeholder Authority\nRun:\n```bash\nmake check\n```\n");
      config.copilot.phases = {
        worker: {
          tool_policy: "full",
          mcp_servers: [],
          instructions: [instrPath],
        },
      };

      const report = await validateConfig(tmpDir, config);
      const policyIssues = report.issues.filter((i) => i.check === "tool-policy");
      expect(policyIssues).toHaveLength(0);
    });
  });

  describe("formatReport", () => {
    it("shows success when no issues", () => {
      const output = formatReport({ issues: [], passed: 7, failed: 0, warnings: 0 });
      expect(output).toContain("All checks passed");
    });

    it("groups issues by check", () => {
      const output = formatReport({
        issues: [
          { check: "files-exist", severity: "error", message: "missing file A" },
          { check: "files-exist", severity: "error", message: "missing file B" },
          { check: "phase-coverage", severity: "warning", message: "phase X missing" },
        ],
        passed: 5,
        failed: 1,
        warnings: 1,
      });
      expect(output).toContain("files-exist (2 issues)");
      expect(output).toContain("phase-coverage (1 issue)");
      expect(output).toContain("2 errors, 1 warnings");
    });
  });
});
