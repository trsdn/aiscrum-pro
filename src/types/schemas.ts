import { z } from "zod";

export const SprintPlanSchema = z.object({
  sprintNumber: z.coerce.number(),
  sprint_issues: z
    .array(
      z.object({
        number: z.coerce.number(),
        title: z.string().default(""),
        ice_score: z
          .number()
          .nullable()
          .default(0)
          .transform((v) => v ?? 0),
        depends_on: z.array(z.coerce.number()).default([]),
        acceptanceCriteria: z.string().default(""),
        expectedFiles: z.array(z.string()).default([]),
        points: z
          .number()
          .nullable()
          .default(0)
          .transform((v) => v ?? 0),
      }),
    )
    .min(1),
  execution_groups: z.array(z.array(z.coerce.number())).optional(),
  estimated_points: z
    .number()
    .nullable()
    .default(0)
    .transform((v) => v ?? 0),
  rationale: z.string().default(""),
});

export const ReviewResultSchema = z.object({
  summary: z.string().default("No summary provided"),
  demoItems: z.array(z.string()).default([]),
  velocityUpdate: z.string().default(""),
  openItems: z.array(z.string()).default([]),
});

export const RetroResultSchema = z.object({
  wentWell: z
    .array(z.string())
    .default([])
    .or(z.undefined().transform(() => [] as string[])),
  wentBadly: z
    .array(z.string())
    .default([])
    .or(z.undefined().transform(() => [] as string[])),
  improvements: z
    .array(
      z.object({
        title: z.string(),
        description: z.string(),
        autoApplicable: z.boolean().default(false),
        target: z.enum(["config", "agent", "skill", "process"]).default("process"),
      }),
    )
    .default([]),
  previousImprovementsChecked: z.boolean().default(false),
});

// Preprocessor that normalizes LLM field name variations before Zod validation
export function normalizeRetroFields(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    wentWell: (raw.wentWell ?? raw.went_well ?? []) as string[],
    wentBadly: (raw.wentBadly ?? raw.went_poorly ?? raw.went_badly ?? []) as string[],
    previousImprovementsChecked: Boolean(
      raw.previousImprovementsChecked ??
      raw.previous_improvements_checked ??
      raw.previous_improvements_applied ??
      false,
    ),
    improvements: normalizeRetroImprovements(raw.improvements),
  };
}

function normalizeRetroImprovements(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const categoryMap: Record<string, string> = {
    config: "config",
    agent: "agent",
    skill: "skill",
    process: "process",
  };
  return raw.map((item: Record<string, unknown>) => ({
    title: (item.title as string) || (item.action as string) || (item.problem as string) || "",
    description:
      (item.description as string) ||
      [item.problem, item.root_cause, item.action, item.expected_outcome]
        .filter(Boolean)
        .join(" — ") ||
      "",
    autoApplicable: item.autoApplicable !== undefined ? Boolean(item.autoApplicable) : true,
    target:
      (item.target as string) || categoryMap[(item.category as string)?.toLowerCase()] || "process",
  }));
}

// --- Action Schemas (#421 + #425) ---

export const CodeReviewActionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approved"),
    reasoning: z.string().default(""),
    summary: z.string().default(""),
    issues: z.array(z.string()).default([]),
  }),
  z.object({
    decision: z.literal("changes_requested"),
    reasoning: z.string().default(""),
    summary: z.string().default(""),
    issues: z.array(z.string()).min(1),
  }),
  z.object({
    decision: z.literal("failed"),
    reasoning: z.string().default(""),
    summary: z.string().default(""),
    issues: z.array(z.string()).default([]),
  }),
]);

export type CodeReviewAction = z.infer<typeof CodeReviewActionSchema>;

export const ChallengerActionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approved"),
    reasoning: z.string().default(""),
    feedback: z.string().default(""),
  }),
  z.object({
    decision: z.literal("rejected"),
    reasoning: z.string().default(""),
    feedback: z.string(),
  }),
]);

export type ChallengerAction = z.infer<typeof ChallengerActionSchema>;

// --- Refinement Schema (#422) ---

export const RefinementResponseSchema = z.object({
  refined_issues: z
    .array(
      z.object({
        number: z.coerce.number(),
        title: z.string().default(""),
        ice_score: z
          .number()
          .nullable()
          .default(0)
          .transform((v) => v ?? 0),
      }),
    )
    .default([]),
});

// --- Acceptance Criteria Schema (#423 + #425) ---

export const AcceptanceCriteriaSchema = z.object({
  approved: z.boolean(),
  reasoning: z.string().default(""),
  summary: z.string().default(""),
  criteria: z
    .array(
      z.object({
        criterion: z.string(),
        passed: z.boolean(),
        evidence: z.string().optional(),
        concern: z.string().optional(),
      }),
    )
    .default([]),
});
