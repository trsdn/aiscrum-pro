/**
 * Init — scaffolds .aiscrum/ structure (roles, config) into a target project.
 *
 * Copies role templates from the Sprint Runner's own .aiscrum/roles/ directory
 * and generates a minimal config file for the target project.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger.js";

const log = logger.child({ component: "init" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Path to the Sprint Runner's own .aiscrum/roles/ (shipped with the package). */
function getTemplateRolesDir(): string {
  // Navigate from src/cli/ → project root → .aiscrum/roles/
  return path.resolve(__dirname, "..", "..", ".aiscrum", "roles");
}

export interface InitOptions {
  targetPath: string;
  force?: boolean;
}

export interface InitResult {
  created: string[];
  skipped: string[];
  configPath: string | null;
}

const MINIMAL_CONFIG = `# AI Scrum Sprint Runner — Project Configuration
# See: https://github.com/trsdn/ai-scrum-autonomous-v2

project:
  name: "my-project"
  base_branch: "main"

sprint:
  max_issues: 6

quality_gates:
  tests: "npm test"
  lint: "npm run lint"
  types: "npx tsc --noEmit"
  # custom_gates:
  #   - name: format-check
  #     command: [npx, prettier, --check, src/]
  #     required: true
  #     category: format
  #   - name: security-scan
  #     command: [npx, audit-ci, --moderate]
  #     required: true
  #     category: security
`;

/**
 * Initialize a target project with .aiscrum/ structure and config.
 */
export function initProject(options: InitOptions): InitResult {
  const { targetPath, force = false } = options;
  const result: InitResult = { created: [], skipped: [], configPath: null };

  const targetRolesDir = path.join(targetPath, ".aiscrum", "roles");
  const templateRolesDir = getTemplateRolesDir();

  if (!fs.existsSync(templateRolesDir)) {
    throw new Error(
      `Template roles not found at ${templateRolesDir}. Sprint Runner installation may be corrupted.`,
    );
  }

  // Copy role templates (includes prompts/ subdirectories)
  copyDirRecursive(templateRolesDir, targetRolesDir, force, result);

  // Generate config if it doesn't exist
  const configPath = path.join(targetPath, ".aiscrum", "config.yaml");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, MINIMAL_CONFIG, "utf-8");
    result.created.push(configPath);
    result.configPath = configPath;
    log.info({ configPath }, "Created config file");
  } else {
    result.skipped.push(configPath);
    log.info({ configPath }, "Config file already exists, skipping");
  }

  return result;
}

function copyDirRecursive(src: string, dest: string, force: boolean, result: InitResult): void {
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip log/ directories — those are runtime artifacts, not templates
    if (entry.isDirectory() && entry.name === "log") continue;

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, force, result);
    } else {
      if (fs.existsSync(destPath) && !force) {
        result.skipped.push(destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
        result.created.push(destPath);
      }
    }
  }
}
