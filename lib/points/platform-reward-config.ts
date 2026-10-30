import { z } from "zod";
import {
  CONFIRMATION_REVIEWER_POINTS,
  DISPATCHER_POINTS,
  DUPLICATE_MARKER_POINTS,
  POINT_AWARD_MAX,
  POINT_TARGET_MAX,
  REPORTER_POINTS,
  REVIEWER_POINTS,
  SOLVER_POINTS,
  TARGET_POINTS,
  TRIAGER_CLEAR_POINTS,
} from "./rules";

const hardCodedValues = {
  solver: SOLVER_POINTS,
  reporter: REPORTER_POINTS,
  reviewer: REVIEWER_POINTS,
  confirmationReviewer: CONFIRMATION_REVIEWER_POINTS,
  triagerClear: TRIAGER_CLEAR_POINTS,
  duplicateMarker: DUPLICATE_MARKER_POINTS,
  dispatcher: DISPATCHER_POINTS,
  target: TARGET_POINTS,
  guidelines: null as string | null,
};

export const platformRewardConfigSchema = z
  .object({
    solver: z.coerce.number().int().min(0).max(POINT_AWARD_MAX).default(SOLVER_POINTS),
    reporter: z.coerce.number().int().min(0).max(POINT_AWARD_MAX).default(REPORTER_POINTS),
    reviewer: z.coerce.number().int().min(0).max(POINT_AWARD_MAX).default(REVIEWER_POINTS),
    confirmationReviewer: z.coerce
      .number()
      .int()
      .min(0)
      .max(POINT_AWARD_MAX)
      .default(CONFIRMATION_REVIEWER_POINTS),
    triagerClear: z.coerce.number().int().min(0).max(POINT_AWARD_MAX).default(TRIAGER_CLEAR_POINTS),
    duplicateMarker: z.coerce.number().int().min(0).max(POINT_AWARD_MAX).default(DUPLICATE_MARKER_POINTS),
    dispatcher: z.coerce.number().int().min(0).max(POINT_AWARD_MAX).default(DISPATCHER_POINTS),
    target: z.coerce.number().int().min(1).max(POINT_TARGET_MAX).default(TARGET_POINTS),
    guidelines: z.string().trim().max(2000).optional().nullable().default(null),
  })
  .default({ ...hardCodedValues });

export type PlatformRewardConfig = z.infer<typeof platformRewardConfigSchema>;

/** Hard-coded ledger amounts — ultimate fallback when DB config is missing. */
export function hardCodedPlatformRewards(): PlatformRewardConfig {
  return {
    solver: hardCodedValues.solver,
    reporter: hardCodedValues.reporter,
    reviewer: hardCodedValues.reviewer,
    confirmationReviewer: hardCodedValues.confirmationReviewer,
    triagerClear: hardCodedValues.triagerClear,
    duplicateMarker: hardCodedValues.duplicateMarker,
    dispatcher: hardCodedValues.dispatcher,
    target: hardCodedValues.target,
    guidelines: null,
  };
}

export function parsePlatformRewardConfig(raw: unknown): PlatformRewardConfig {
  if (!raw || typeof raw !== "object") return hardCodedPlatformRewards();
  const result = platformRewardConfigSchema.safeParse(raw);
  return result.success ? result.data : hardCodedPlatformRewards();
}

export function parsePlatformRewardConfigFromFormData(formData: FormData): PlatformRewardConfig {
  const hard = hardCodedPlatformRewards();
  const num = (key: string, fallback: number) => {
    const raw = formData.get(key);
    if (raw === null || raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  return platformRewardConfigSchema.parse({
    solver: num("solverPoints", hard.solver),
    reporter: num("reporterPoints", hard.reporter),
    reviewer: num("reviewerPoints", hard.reviewer),
    confirmationReviewer: num("confirmationReviewerPoints", hard.confirmationReviewer),
    triagerClear: num("triagerClearPoints", hard.triagerClear),
    duplicateMarker: num("duplicateMarkerPoints", hard.duplicateMarker),
    dispatcher: num("dispatcherPoints", hard.dispatcher),
    target: num("targetPoints", hard.target),
    guidelines: String(formData.get("rewardGuidelines") ?? "").trim() || null,
  });
}
