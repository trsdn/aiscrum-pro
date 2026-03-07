#!/usr/bin/env node

/**
 * AiScrum Pro CLI — ACP-powered autonomous Scrum engine.
 *
 * Usage:
 *   aiscrum plan --sprint <N>
 *   aiscrum execute-issue --issue <N> --sprint <N>
 *   aiscrum check-quality --branch <branch>
 *   aiscrum full-cycle --sprint <N>
 *   aiscrum refine --sprint <N>
 *   aiscrum review --sprint <N>
 *   aiscrum retro --sprint <N>
 *   aiscrum status
 *   aiscrum pause
 *   aiscrum resume
 *   aiscrum metrics --sprint <N>
 *   aiscrum drift-report --sprint <N>
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
  .name("aiscrum")
  .description("AiScrum Pro — ACP-powered autonomous Scrum engine for GitHub Copilot CLI")
  .version(pkg.version)
  .option("--config <path>", "Path to config file");

registerCommands(program);

program.parse();
