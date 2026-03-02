import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { initProject } from "../../src/cli/init.js";

describe("initProject", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "init-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scaffolds .aiscrum/roles/ into target directory", () => {
    const result = initProject({ targetPath: tmpDir });

    expect(fs.existsSync(path.join(tmpDir, ".aiscrum", "roles"))).toBe(true);
    expect(result.created.length).toBeGreaterThan(0);
  });

  it("creates all role directories", () => {
    initProject({ targetPath: tmpDir });

    const roles = fs.readdirSync(path.join(tmpDir, ".aiscrum", "roles"));
    expect(roles).toContain("refiner");
    expect(roles).toContain("planner");
    expect(roles).toContain("reviewer");
    expect(roles).toContain("researcher");
    expect(roles).toContain("general");
    expect(roles).toContain("retro");
  });

  it("creates copilot-instructions.md for each role", () => {
    initProject({ targetPath: tmpDir });

    for (const role of ["refiner", "planner", "reviewer", "researcher", "general", "retro"]) {
      const instructionsPath = path.join(tmpDir, ".aiscrum", "roles", role, "copilot-instructions.md");
      expect(fs.existsSync(instructionsPath), `${role} instructions missing`).toBe(true);
    }
  });

  it("creates .aiscrum/config.yaml", () => {
    const result = initProject({ targetPath: tmpDir });

    const configPath = path.join(tmpDir, ".aiscrum", "config.yaml");
    expect(fs.existsSync(configPath)).toBe(true);
    expect(result.configPath).toBe(configPath);

    const content = fs.readFileSync(configPath, "utf-8");
    expect(content).toContain("project:");
    expect(content).toContain("sprint:");
  });

  it("skips existing files without --force", () => {
    // First init
    initProject({ targetPath: tmpDir });
    // Second init
    const result = initProject({ targetPath: tmpDir });

    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.created.length).toBe(0);
  });

  it("overwrites existing files with --force", () => {
    // First init
    initProject({ targetPath: tmpDir });
    // Second init with force
    const result = initProject({ targetPath: tmpDir, force: true });

    // Config is always skipped (even with force, only role files are overwritten)
    // Role files should be re-created
    expect(result.created.length).toBeGreaterThan(0);
  });

  it("does not copy log/ directories", () => {
    initProject({ targetPath: tmpDir });

    const rolesDir = path.join(tmpDir, ".aiscrum", "roles");
    const allDirs: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          allDirs.push(entry.name);
          walk(path.join(dir, entry.name));
        }
      }
    };
    walk(rolesDir);

    expect(allDirs).not.toContain("log");
  });

  it("copies skill files into role directories", () => {
    initProject({ targetPath: tmpDir });

    // Refiner should have skills
    const refinerSkills = path.join(tmpDir, ".aiscrum", "roles", "refiner", "skills");
    expect(fs.existsSync(refinerSkills)).toBe(true);
    const skillDirs = fs.readdirSync(refinerSkills);
    expect(skillDirs.length).toBeGreaterThan(0);
  });
});
