import { describe, it, expect } from "vitest";
import {
  CodeReviewActionSchema,
  ChallengerActionSchema,
  RefinementResponseSchema,
  AcceptanceCriteriaSchema,
  RetroResultSchema,
  ReviewResultSchema,
  normalizeRetroFields,
} from "../../src/types/schemas.js";

describe("CodeReviewActionSchema", () => {
  it("parses approved decision", () => {
    const result = CodeReviewActionSchema.parse({
      decision: "approved",
      reasoning: "Code is solid",
      summary: "All good",
      issues: [],
    });
    expect(result.decision).toBe("approved");
    expect(result.reasoning).toBe("Code is solid");
  });

  it("parses changes_requested with issues", () => {
    const result = CodeReviewActionSchema.parse({
      decision: "changes_requested",
      reasoning: "Missing tests",
      summary: "Needs work",
      issues: ["no tests for edge case"],
    });
    expect(result.decision).toBe("changes_requested");
    expect(result.issues).toHaveLength(1);
  });

  it("rejects changes_requested without issues", () => {
    expect(() =>
      CodeReviewActionSchema.parse({
        decision: "changes_requested",
        reasoning: "bad",
        issues: [],
      }),
    ).toThrow();
  });

  it("defaults optional fields", () => {
    const result = CodeReviewActionSchema.parse({ decision: "approved" });
    expect(result.reasoning).toBe("");
    expect(result.summary).toBe("");
    expect(result.issues).toEqual([]);
  });

  it("rejects invalid decision", () => {
    expect(() => CodeReviewActionSchema.parse({ decision: "maybe" })).toThrow();
  });
});

describe("ChallengerActionSchema", () => {
  it("parses approved", () => {
    const result = ChallengerActionSchema.parse({
      decision: "approved",
      reasoning: "Solid work",
      feedback: "All clear",
    });
    expect(result.decision).toBe("approved");
  });

  it("parses rejected with required feedback", () => {
    const result = ChallengerActionSchema.parse({
      decision: "rejected",
      reasoning: "Missing coverage",
      feedback: "Add tests for auth module",
    });
    expect(result.decision).toBe("rejected");
    expect(result.feedback).toBe("Add tests for auth module");
  });

  it("rejects unknown decision", () => {
    expect(() => ChallengerActionSchema.parse({ decision: "unknown" })).toThrow();
  });
});

describe("RefinementResponseSchema", () => {
  it("parses refined issues with defaults", () => {
    const result = RefinementResponseSchema.parse({
      refined_issues: [{ number: 1, title: "Fix bug", ice_score: null }],
    });
    expect(result.refined_issues[0].ice_score).toBe(0);
  });

  it("defaults to empty array when missing", () => {
    const result = RefinementResponseSchema.parse({});
    expect(result.refined_issues).toEqual([]);
  });
});

describe("AcceptanceCriteriaSchema", () => {
  it("parses full result", () => {
    const result = AcceptanceCriteriaSchema.parse({
      approved: true,
      reasoning: "All criteria met",
      summary: "Passed",
      criteria: [{ criterion: "returns results", passed: true, evidence: "test passes" }],
    });
    expect(result.approved).toBe(true);
    expect(result.criteria).toHaveLength(1);
  });

  it("defaults optional fields", () => {
    const result = AcceptanceCriteriaSchema.parse({ approved: false });
    expect(result.reasoning).toBe("");
    expect(result.summary).toBe("");
    expect(result.criteria).toEqual([]);
  });

  it("rejects missing approved", () => {
    expect(() => AcceptanceCriteriaSchema.parse({})).toThrow();
  });

  it("accepts null concern and evidence fields", () => {
    const result = AcceptanceCriteriaSchema.parse({
      approved: false,
      criteria: [{ criterion: "test", passed: false, concern: null, evidence: null }],
    });
    expect(result.criteria[0].concern).toBeNull();
    expect(result.criteria[0].evidence).toBeNull();
  });
});

describe("normalizeRetroFields", () => {
  it("normalizes snake_case to camelCase", () => {
    const result = normalizeRetroFields({
      went_well: ["a"],
      went_poorly: ["b"],
      previous_improvements_checked: true,
      improvements: [],
    });
    expect(result.wentWell).toEqual(["a"]);
    expect(result.wentBadly).toEqual(["b"]);
    expect(result.previousImprovementsChecked).toBe(true);
  });

  it("normalizes improvement fields", () => {
    const result = normalizeRetroFields({
      improvements: [{ problem: "Slow CI", action: "Parallelize", category: "config" }],
    });
    const improvements = result.improvements as Array<Record<string, unknown>>;
    expect(improvements[0].title).toBe("Parallelize");
    expect(improvements[0].target).toBe("config");
  });

  it("coerces file-path targets to valid enum values", () => {
    const result = normalizeRetroFields({
      improvements: [
        { title: "Update planner", description: "d", target: ".aiscrum/roles/planner/" },
        { title: "Fix ceremonies", description: "d", target: "src/ceremonies/" },
        { title: "Update config", description: "d", target: ".aiscrum/config.yaml" },
      ],
    });
    const improvements = result.improvements as Array<Record<string, unknown>>;
    expect(improvements[0].target).toBe("agent");
    expect(improvements[1].target).toBe("process");
    expect(improvements[2].target).toBe("config");
    // Verify they pass schema validation
    const parsed = RetroResultSchema.parse(result);
    expect(parsed.improvements).toHaveLength(3);
  });

  it("passes through RetroResultSchema", () => {
    const normalized = normalizeRetroFields({
      went_well: ["fast delivery"],
      went_poorly: ["flaky tests"],
      improvements: [
        {
          title: "Fix flaky tests",
          description: "Add retries",
          autoApplicable: true,
          target: "process",
        },
      ],
    });
    const result = RetroResultSchema.parse(normalized);
    expect(result.wentWell).toEqual(["fast delivery"]);
    expect(result.improvements[0].title).toBe("Fix flaky tests");
  });
});

describe("ReviewResultSchema", () => {
  it("applies defaults for missing fields", () => {
    const result = ReviewResultSchema.parse({});
    expect(result.summary).toBe("No summary provided");
    expect(result.demoItems).toEqual([]);
    expect(result.openItems).toEqual([]);
  });
});
