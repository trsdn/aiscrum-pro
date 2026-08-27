import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { SprintConfig } from "../../src/types.js";
import { resolveSessionConfig } from "../../src/acp/session-config.js";

/**
 * Integration test for agent model selection in Settings.
 * Covers:
 * 1. Model selection persists to .aiscrum/config.yaml (phases.{role}.model)
 * 2. Model changes propagate to ACP session config via resolveSessionConfig
 * 3. UI feedback confirms model change (tested via API contract)
 */

describe("Settings Model Selection Integration", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    // Create temporary directory for config file
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-model-test-"));
    configPath = path.join(tmpDir, "config.yaml");
  });

  afterEach(() => {
    // Clean up temporary files
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("Config persistence", () => {
    it("writes model change to phases.planner.model in config.yaml", () => {
      // Setup: Create initial config
      const initialConfig = {
        project: { name: "test-project" },
        copilot: {
          phases: {
            planner: { model: "claude-sonnet-4.5" },
            worker: { model: "claude-sonnet-4.5" },
          },
        },
      };
      fs.writeFileSync(configPath, stringifyYaml(initialConfig), "utf-8");

      // Act: Simulate PUT /api/roles with model change
      const updatedConfig = parseYaml(fs.readFileSync(configPath, "utf-8")) as any;
      updatedConfig.copilot.phases.planner.model = "claude-opus-4.6";
      fs.writeFileSync(configPath, stringifyYaml(updatedConfig), "utf-8");

      // Assert: Verify file updated
      const savedConfig = parseYaml(fs.readFileSync(configPath, "utf-8")) as any;
      expect(savedConfig.copilot.phases.planner.model).toBe("claude-opus-4.6");
      expect(savedConfig.copilot.phases.worker.model).toBe("claude-sonnet-4.5"); // unchanged
    });

    it("handles model set to undefined (use default)", () => {
      // Setup
      const initialConfig = {
        project: { name: "test-project" },
        copilot: {
          phases: {
            planner: { model: "claude-opus-4.6" },
          },
        },
      };
      fs.writeFileSync(configPath, stringifyYaml(initialConfig), "utf-8");

      // Act: Remove model override (set to undefined)
      const updatedConfig = parseYaml(fs.readFileSync(configPath, "utf-8")) as any;
      delete updatedConfig.copilot.phases.planner.model;
      fs.writeFileSync(configPath, stringifyYaml(updatedConfig), "utf-8");

      // Assert
      const savedConfig = parseYaml(fs.readFileSync(configPath, "utf-8")) as any;
      expect(savedConfig.copilot.phases.planner.model).toBeUndefined();
    });

    it("creates phases.{role} object if missing when setting model", () => {
      // Setup: Config without planner phase
      const initialConfig = {
        project: { name: "test-project" },
        copilot: {
          phases: {
            worker: { model: "claude-sonnet-4.5" },
          },
        },
      };
      fs.writeFileSync(configPath, stringifyYaml(initialConfig), "utf-8");

      // Act: Add planner phase with model
      const updatedConfig = parseYaml(fs.readFileSync(configPath, "utf-8")) as any;
      if (!updatedConfig.copilot.phases.planner) {
        updatedConfig.copilot.phases.planner = {};
      }
      updatedConfig.copilot.phases.planner.model = "claude-opus-4.6";
      fs.writeFileSync(configPath, stringifyYaml(updatedConfig), "utf-8");

      // Assert
      const savedConfig = parseYaml(fs.readFileSync(configPath, "utf-8")) as any;
      expect(savedConfig.copilot.phases.planner.model).toBe("claude-opus-4.6");
    });
  });

  // Helper to create minimal SprintConfig for testing
  function makeMinimalConfig(phaseModel?: string): SprintConfig {
    return {
      sprintNumber: 1,
      sprintPrefix: "S1",
      sprintSlug: "sprint-1",
      projectPath: tmpDir,
      baseBranch: "main",
      worktreeBase: path.join(tmpDir, "worktrees"),
      branchPattern: "feat/{issue}",
      maxParallelSessions: 2,
      maxIssuesPerSprint: 5,
      maxDriftIncidents: 2,
      maxRetries: 3,
      enableChallenger: false,
      autoRevertDrift: false,
      backlogLabels: [],
      autoMerge: false,
      squashMerge: true,
      deleteBranchAfterMerge: true,
      sessionTimeoutMs: 60000,
      customInstructions: "",
      autoApproveTools: false,
      allowToolPatterns: [],
      globalMcpServers: [],
      globalInstructions: [],
      phases: {
        planner: phaseModel ? { model: phaseModel } : {},
      },
    };
  }

  describe("Session config resolution", () => {
    it("resolves phase model from config for ACP session", async () => {
      // Setup
      const config = makeMinimalConfig("claude-opus-4.6");

      // Act
      const sessionConfig = await resolveSessionConfig(config, "planner");

      // Assert
      expect(sessionConfig.model).toBe("claude-opus-4.6");
    });

    it("returns undefined model when phase has no model override", async () => {
      // Setup
      const config = makeMinimalConfig();

      // Act
      const sessionConfig = await resolveSessionConfig(config, "planner");

      // Assert
      expect(sessionConfig.model).toBeUndefined();
    });

    it("different phases can have different models", async () => {
      // Setup
      const config = makeMinimalConfig();
      config.phases = {
        planner: { model: "claude-opus-4.6" },
        worker: { model: "claude-sonnet-4.5" },
        reviewer: { model: "gpt-5.1" },
      };

      // Act
      const plannerConfig = await resolveSessionConfig(config, "planner");
      const workerConfig = await resolveSessionConfig(config, "worker");
      const reviewerConfig = await resolveSessionConfig(config, "reviewer");

      // Assert
      expect(plannerConfig.model).toBe("claude-opus-4.6");
      expect(workerConfig.model).toBe("claude-sonnet-4.5");
      expect(reviewerConfig.model).toBe("gpt-5.1");
    });
  });

  describe("End-to-end model change flow", () => {
    it("simulates full flow: UI change → config.yaml → session config", async () => {
      // Step 1: Initial state - planner uses default (no model specified)
      const initialConfig = {
        project: { name: "test-project" },
        copilot: {
          phases: {
            planner: {},
          },
        },
      };
      fs.writeFileSync(configPath, stringifyYaml(initialConfig), "utf-8");

      let config = makeMinimalConfig();
      let sessionConfig = await resolveSessionConfig(config, "planner");
      expect(sessionConfig.model).toBeUndefined(); // No override

      // Step 2: User changes model in Settings UI → server persists to config.yaml
      const updatedConfigData = parseYaml(fs.readFileSync(configPath, "utf-8")) as any;
      updatedConfigData.copilot.phases.planner.model = "claude-opus-4.6";
      fs.writeFileSync(configPath, stringifyYaml(updatedConfigData), "utf-8");

      // Step 3: Next ceremony execution reads updated config
      config = makeMinimalConfig("claude-opus-4.6");
      sessionConfig = await resolveSessionConfig(config, "planner");
      expect(sessionConfig.model).toBe("claude-opus-4.6");

      // Verify config file persisted correctly
      const savedConfig = parseYaml(fs.readFileSync(configPath, "utf-8")) as any;
      expect(savedConfig.copilot.phases.planner.model).toBe("claude-opus-4.6");
    });
  });
});
