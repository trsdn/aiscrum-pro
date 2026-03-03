import { z } from "zod";

export const SprintPlanSchema = z.object({
  sprintNumber: z.coerce.number(),
  sprint_issues: z
    .array(
      z.object({
        number: z.coerce.number(),
        title: z.string().default(""),
        ice_score: z.number().nullable().default(0).transform((v) => v ?? 0),
        depends_on: z.array(z.coerce.number()).default([]),
        acceptanceCriteria: z.string().default(""),
        expectedFiles: z.array(z.string()).default([]),
        points: z.number().nullable().default(0).transform((v) => v ?? 0),
      }),
    )
    .min(1),
  execution_groups: z.array(z.array(z.coerce.number())).optional(),
  estimated_points: z.number().default(0),
  rationale: z.string().default(""),
});

export const ReviewResultSchema = z.object({
  summary: z.string().default("No summary provided"),
  demoItems: z.array(z.string()).default([]),
  velocityUpdate: z.string().default(""),
  openItems: z.array(z.string()).default([]),
});

export const RetroResultSchema = z.object({
  wentWell: z.array(z.string()).default([]),
  wentBadly: z.array(z.string()).default([]),
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
