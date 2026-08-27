#!/usr/bin/env node
// Extracts the notes for a single version out of CHANGELOG.md so the release
// workflow can feed them to `gh release create --notes-file`.
//
//   node scripts/release-notes.mjs v0.4.0 [path/to/CHANGELOG.md]
//
// Exits non-zero when the version has no section, so a release fails loudly
// instead of publishing empty notes.

import { readFileSync } from "node:fs";
import { argv, exit, stdout } from "node:process";
import { pathToFileURL } from "node:url";

// Matches the heading styles already used in this CHANGELOG:
//   "## [0.4.0] — 2026-03-07", "## v0.2.0", "## 0.2.0", "## [0.2.0](link)"
const VERSION_HEADING = /^##\s+\[?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\]?/;

export function extractReleaseNotes(changelog, version) {
  const wanted = String(version ?? "")
    .trim()
    .replace(/^v/, "");

  if (!wanted) {
    throw new Error("A version argument is required, e.g. `release-notes.mjs v0.4.0`.");
  }

  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => VERSION_HEADING.exec(line)?.[1] === wanted);

  if (start === -1) {
    throw new Error(
      `No CHANGELOG section found for version ${wanted}. ` +
        `Add a "## [${wanted}]" heading before tagging the release.`,
    );
  }

  // A section runs until the next level-2 heading (any heading, not just a
  // version one, so "## [Unreleased]" also terminates it).
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();

  if (!body) {
    throw new Error(`The CHANGELOG section for version ${wanted} is empty.`);
  }

  return body;
}

function main() {
  const [version, changelogPath = "CHANGELOG.md"] = argv.slice(2);

  try {
    stdout.write(`${extractReleaseNotes(readFileSync(changelogPath, "utf-8"), version)}\n`);
  } catch (error) {
    console.error(`release-notes: ${error.message}`);
    exit(1);
  }
}

// Only run the CLI when executed directly, so tests can import the function.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main();
}
