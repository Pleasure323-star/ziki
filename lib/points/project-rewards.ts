import { z } from "zod";
import {
  POINT_AWARD_MAX,
  SOLVER_POINTS,
  REPORTER_POINTS,
  REVIEWER_POINTS,
} from "./rules";

export const projectRewardConfigSchema = z
  .object({
    solver: z.coerce.number().int().min(0).max(POINT_AWARD_MAX).default(SOLVER_POINTS),
    reporter: z.coerce.number().int().min(0).max(POINT_AWARD_MAX).default(REPORTER_POINTS),
    reviewer: z.coerce.number().int().min(0).max(POINT_AWARD_MAX).default(REVIEWER_POINTS),
    guidelines: z.string().trim().max(2000).optional().nullable().default(null),
  })
  .default({
    solver: SOLVER_POINTS,
    reporter: REPORTER_POINTS,
    reviewer: REVIEWER_POINTS,
    guidelines: null,
  });

export type ProjectRewardConfig = z.infer<typeof projectRewardConfigSchema>;

/** Parse a project override. Pass `base` so missing fields inherit platform defaults. */
export function parseProjectRewardConfig(
  raw: unknown,
  base?: ProjectRewardConfig | null,
): ProjectRewardConfig {
  const fallback = base ?? projectRewardConfigSchema.parse({});
  if (!raw || typeof raw !== "object") return fallback;
  const result = projectRewardConfigSchema.safeParse({
    ...fallback,
    ...(raw as object),
    solver: (raw as { solver?: unknown }).solver ?? fallback.solver,
  });
  return result.success ? result.data : fallback;
}

export function calculateSolverPoints(config?: ProjectRewardConfig | null): number {
  if (!config) return SOLVER_POINTS;
  return config.solver ?? SOLVER_POINTS;
}

export function calculateReporterPoints(config?: ProjectRewardConfig | null): number {
  if (!config) return REPORTER_POINTS;
  return config.reporter ?? REPORTER_POINTS;
}

export function calculateReviewerPoints(config?: ProjectRewardConfig | null): number {
  if (!config) return REVIEWER_POINTS;
  return config.reviewer ?? REVIEWER_POINTS;
}
