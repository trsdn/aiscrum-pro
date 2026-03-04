#!/usr/bin/env node

/**
 * Sprint Runner CLI — ACP-powered autonomous sprint engine.
 *
 * Usage:
 *   sprint-runner plan --sprint <N>
 *   sprint-runner execute-issue --issue <N> --sprint <N>
 *   sprint-runner check-quality --branch <branch>
 *   sprint-runner full-cycle --sprint <N>
 *   sprint-runner refine --sprint <N>
 *   sprint-runner review --sprint <N>
 *   sprint-runner retro --sprint <N>
 *   sprint-runner status
 *   sprint-runner pause
 *   sprint-runner resume
 *   sprint-runner metrics --sprint <N>
 *   sprint-runner drift-report --sprint <N>
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { registerCommands } from "./cli/commands.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"));

// Global SIGINT handler removed — individual commands register their own cleanup handlers

const program = new Command();

program
  .name("sprint-runner")
  .description("ACP-powered autonomous sprint engine for GitHub Copilot CLI")
  .version(pkg.version)
  .option("--config <path>", "Path to config file");

registerCommands(program);

program.parse();
