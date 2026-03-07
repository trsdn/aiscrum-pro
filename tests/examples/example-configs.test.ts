import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { loadConfig } from "../../src/config.js";

const EXAMPLES_DIR = path.resolve(__dirname, "../../examples");

const STACKS = ["typescript", "python", "react", "go"] as const;
const REQUIRED_ROLES = [
  "general",
  "planner",
  "refiner",
  "reviewer",
  "test-engineer",
  "retro",
] as const;

function withNtfyTopic<T>(fn: () => T): T {
  const orig = process.env.NTFY_TOPIC;
  process.env.NTFY_TOPIC = "test-topic";
  try {
    return fn();
  } finally {
    if (orig === undefined) {
      delete process.env.NTFY_TOPIC;
    } else {
      process.env.NTFY_TOPIC = orig;
    }
  }
}

function readRole(stack: string, role: string): string {
  return fs.readFileSync(
    path.join(EXAMPLES_DIR, stack, ".aiscrum", "roles", role, "copilot-instructions.md"),
    "utf-8",
  );
}

describe("example configs", () => {
  for (const stack of STACKS) {
    const configPath = path.join(EXAMPLES_DIR, stack, ".aiscrum", "config.yaml");

    describe(stack, () => {
      it("config.yaml exists", () => {
        expect(fs.existsSync(configPath)).toBe(true);
      });

      it("passes Zod schema validation", () => {
        const config = withNtfyTopic(() => loadConfig(configPath));
        expect(config.project.name).toBeTruthy();
        expect(config.sprint.prefix).toBe("Sprint");
        expect(config.quality_gates).toBeDefined();
        expect(config.git.branch_pattern).toContain("{issue}");
      });

      it("has all required role directories with copilot-instructions.md", () => {
        for (const role of REQUIRED_ROLES) {
          const instrFile = path.join(
            EXAMPLES_DIR,
            stack,
            ".aiscrum",
            "roles",
            role,
            "copilot-instructions.md",
          );
          expect(
            fs.existsSync(instrFile),
            `missing ${stack}/roles/${role}/copilot-instructions.md`,
          ).toBe(true);
        }
      });

      it("has quality gate commands defined", () => {
        const config = withNtfyTopic(() => loadConfig(configPath));
        expect(config.quality_gates.test_command).toBeDefined();
        expect(config.quality_gates.lint_command).toBeDefined();
      });

      it("has prompts for roles that need them", () => {
        const promptMap: Record<string, string[]> = {
          general: ["worker.md"],
          planner: ["planning.md", "item-planner.md"],
          refiner: ["refinement.md"],
          reviewer: ["review.md"],
          retro: ["retro.md"],
          "test-engineer": ["tdd.md"],
        };
        for (const [role, prompts] of Object.entries(promptMap)) {
          for (const prompt of prompts) {
            const promptFile = path.join(
              EXAMPLES_DIR,
              stack,
              ".aiscrum",
              "roles",
              role,
              "prompts",
              prompt,
            );
            expect(
              fs.existsSync(promptFile),
              `missing ${stack}/roles/${role}/prompts/${prompt}`,
            ).toBe(true);
          }
        }
      });

      it("has skills for roles that need them", () => {
        const skillMap: Record<string, string[]> = {
          planner: ["sprint-planning"],
          refiner: ["codebase-research", "issue-editing"],
          reviewer: ["code-review", "tdd-workflow"],
          retro: ["copilot-authoring"],
        };
        for (const [role, skills] of Object.entries(skillMap)) {
          for (const skill of skills) {
            const skillFile = path.join(
              EXAMPLES_DIR,
              stack,
              ".aiscrum",
              "roles",
              role,
              "skills",
              skill,
              "SKILL.md",
            );
            expect(
              fs.existsSync(skillFile),
              `missing ${stack}/roles/${role}/skills/${skill}/SKILL.md`,
            ).toBe(true);
          }
        }
      });
    });
  }
});

describe("prompts contain template variables", () => {
  for (const stack of STACKS) {
    it(`${stack} worker prompt has {{ISSUE_NUMBER}}`, () => {
      const content = fs.readFileSync(
        path.join(EXAMPLES_DIR, stack, ".aiscrum", "roles", "general", "prompts", "worker.md"),
        "utf-8",
      );
      expect(content).toContain("{{ISSUE_NUMBER}}");
      expect(content).toContain("{{ISSUE_TITLE}}");
      expect(content).toContain("{{MAX_DIFF_LINES}}");
    });

    it(`${stack} planning prompt has {{SPRINT_NUMBER}}`, () => {
      const content = fs.readFileSync(
        path.join(EXAMPLES_DIR, stack, ".aiscrum", "roles", "planner", "prompts", "planning.md"),
        "utf-8",
      );
      expect(content).toContain("{{SPRINT_NUMBER}}");
      expect(content).toContain("{{PROJECT_NAME}}");
    });
  }
});

describe("skills have frontmatter", () => {
  const allSkills = [
    ["planner", "sprint-planning"],
    ["refiner", "codebase-research"],
    ["refiner", "issue-editing"],
    ["reviewer", "code-review"],
    ["reviewer", "tdd-workflow"],
    ["retro", "copilot-authoring"],
  ] as const;

  for (const [role, skill] of allSkills) {
    it(`${role}/${skill} has name and description frontmatter`, () => {
      const content = fs.readFileSync(
        path.join(
          EXAMPLES_DIR,
          "typescript",
          ".aiscrum",
          "roles",
          role,
          "skills",
          skill,
          "SKILL.md",
        ),
        "utf-8",
      );
      expect(content).toMatch(/^---/);
      expect(content).toContain("name:");
      expect(content).toContain("description:");
    });
  }
});

describe("role instructions structure", () => {
  for (const stack of STACKS) {
    describe(stack, () => {
      for (const role of REQUIRED_ROLES) {
        describe(role, () => {
          it("starts with a markdown heading", () => {
            const content = readRole(stack, role);
            expect(content.trimStart()).toMatch(/^# .+/);
          });

          it("has a ## Role or ## Workflow section", () => {
            const content = readRole(stack, role);
            expect(content).toMatch(/## (Role|Workflow)/);
          });

          it("has a ## Rules section", () => {
            const content = readRole(stack, role);
            expect(content).toMatch(/## Rules/);
          });

          it("is non-trivial (>200 chars)", () => {
            const content = readRole(stack, role);
            expect(content.length).toBeGreaterThan(200);
          });
        });
      }
    });
  }
});

describe("role instructions content", () => {
  describe("shared roles are consistent across stacks", () => {
    const sharedRoles = ["general", "planner", "refiner", "reviewer", "retro"] as const;

    for (const role of sharedRoles) {
      it(`${role} is identical across all stacks`, () => {
        const contents = STACKS.map((stack) => readRole(stack, role));
        for (let i = 1; i < contents.length; i++) {
          expect(contents[i], `${role} differs between ${STACKS[0]} and ${STACKS[i]}`).toBe(
            contents[0],
          );
        }
      });
    }
  });

  describe("test-engineer is stack-specific", () => {
    it("typescript mentions Vitest", () => {
      expect(readRole("typescript", "test-engineer")).toMatch(/vitest/i);
    });

    it("python mentions pytest", () => {
      expect(readRole("python", "test-engineer")).toMatch(/pytest/i);
    });

    it("react mentions React Testing Library", () => {
      expect(readRole("react", "test-engineer")).toMatch(/testing.library/i);
    });

    it("go mentions Go testing stdlib", () => {
      expect(readRole("go", "test-engineer")).toMatch(/testing|t\.Run/);
    });

    it("each stack has a unique test-engineer", () => {
      const contents = STACKS.map((stack) => readRole(stack, "test-engineer"));
      const unique = new Set(contents);
      expect(unique.size).toBe(STACKS.length);
    });
  });
});

describe("stack-specific quality gates", () => {
  it("typescript uses vitest and eslint", () => {
    const config = withNtfyTopic(() =>
      loadConfig(path.join(EXAMPLES_DIR, "typescript", ".aiscrum", "config.yaml")),
    );
    expect(config.quality_gates.test_command).toContain("vitest");
    expect(config.quality_gates.lint_command).toContain("eslint");
    expect(config.quality_gates.require_types).toBe(true);
    expect(config.quality_gates.require_build).toBe(true);
  });

  it("python uses pytest and ruff, no build", () => {
    const config = withNtfyTopic(() =>
      loadConfig(path.join(EXAMPLES_DIR, "python", ".aiscrum", "config.yaml")),
    );
    expect(config.quality_gates.test_command).toContain("pytest");
    expect(config.quality_gates.lint_command).toContain("ruff");
    expect(config.quality_gates.typecheck_command).toContain("mypy");
    expect(config.quality_gates.require_build).toBe(false);
  });

  it("react uses vitest and vite build with TDD enabled", () => {
    const config = withNtfyTopic(() =>
      loadConfig(path.join(EXAMPLES_DIR, "react", ".aiscrum", "config.yaml")),
    );
    expect(config.quality_gates.test_command).toContain("vitest");
    expect(config.quality_gates.build_command).toContain("vite");
    expect(config.sprint.enable_tdd).toBe(true);
  });

  it("go uses go test and golangci-lint with TDD enabled", () => {
    const config = withNtfyTopic(() =>
      loadConfig(path.join(EXAMPLES_DIR, "go", ".aiscrum", "config.yaml")),
    );
    expect(config.quality_gates.test_command).toContain("go");
    expect(config.quality_gates.lint_command).toContain("golangci-lint");
    expect(config.quality_gates.typecheck_command).toContain("vet");
    expect(config.sprint.enable_tdd).toBe(true);
  });
});
