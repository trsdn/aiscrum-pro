import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "../scripts/release-notes.mjs");
const CHANGELOG = resolve(import.meta.dirname, "../CHANGELOG.md");

function run(version: string, changelogPath = CHANGELOG): string {
  return execFileSync(process.execPath, [SCRIPT, version, changelogPath], {
    encoding: "utf-8",
  }).trim();
}

function runExpectingFailure(version: string, changelogPath = CHANGELOG): string {
  try {
    run(version, changelogPath);
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? "");
  }

  throw new Error(`Expected release-notes to fail for "${version}", but it succeeded.`);
}

function fixture(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "release-notes-")), "CHANGELOG.md");
  writeFileSync(path, contents);
  return path;
}

describe("scripts/release-notes.mjs", () => {
  it("extracts a bracketed, dated heading", () => {
    const notes = run("v0.4.0");

    expect(notes).toContain("GitHub Pages landing site");
    // The next section must not bleed in.
    expect(notes).not.toContain("Interactive ACP session control");
  });

  it("extracts a bare `## vX.Y.Z` heading", () => {
    expect(run("v0.2.0")).toContain("`/refine` ceremony");
  });

  it("accepts the version with or without a leading v", () => {
    expect(run("0.4.0")).toBe(run("v0.4.0"));
  });

  it("stops at the next level-2 heading, including `## [Unreleased]`", () => {
    const path = fixture(
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "- pending",
        "",
        "## [1.0.0]",
        "",
        "- shipped",
        "",
      ].join("\n"),
    );

    expect(run("1.0.0", path)).toBe("- shipped");
  });

  it("fails with an actionable message when the version has no section", () => {
    expect(runExpectingFailure("v9.9.9")).toContain("No CHANGELOG section found for version 9.9.9");
  });

  it("fails when the section exists but is empty", () => {
    const path = fixture(
      ["# Changelog", "", "## [1.0.0]", "", "## [0.9.0]", "", "- old", ""].join("\n"),
    );

    expect(runExpectingFailure("1.0.0", path)).toContain("is empty");
  });

  it("has release notes for the version in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf-8"),
    ) as { version: string };

    expect(() => run(pkg.version)).not.toThrow();
  });
});
