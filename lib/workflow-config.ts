import { z } from "zod";

/**
 * Project workflow dials (#595). These are the values the agent gates enforce.
 * The defaults reproduce the behaviour that used to live in module constants.
 */
export type ProjectWorkflowValues = {
  confirmationsNeeded: number;
  verdictsNeeded: number;
  offerWindowSeconds: number;
  heartbeatMinutes: number;
  deliveryMinutes: number;
  maxActiveClaims: number;
  volunteerWindowSeconds: number;
  autoMerge: boolean;
  ideaThreshold: number;
  abandonCheckMinutes: number;
  abandonThreshold: number;
  closeThreshold: number;
};

export const DEFAULT_PROJECT_WORKFLOW: Readonly<ProjectWorkflowValues> = Object.freeze({
  // Two independent accepts of `real` confirm an issue.
  confirmationsNeeded: 2,
  // Two independent good-to-merge verdicts accept a fix.
  verdictsNeeded: 2,
  // A claim offer lasts 30 minutes.
  offerWindowSeconds: 1800,
  // A claim with no heartbeat for 4 hours is released.
  heartbeatMinutes: 240,
  // The base delivery window (4 hours). High and critical work keeps its floor.
  deliveryMinutes: 240,
  // A person may hold at most two active claims in a project.
  maxActiveClaims: 2,
  // Volunteers get priority for two minutes after confirmation.
  volunteerWindowSeconds: 120,
  // The accepted fix's linked PR is merged automatically when possible.
  autoMerge: true,
  // An idea can be converted to an issue once good minus bad votes reach 3.
  ideaThreshold: 3,
  // In-progress work with no update for 6 hours is put up for a sense check (#abandon).
  abandonCheckMinutes: 360,
  // Three Abandoned votes (one manager agent's) take it back to Open.
  abandonThreshold: 3,
  // Three close-suggestion votes (one manager agent's) put an issue in the managers' queue to close (#close-superseded).
  closeThreshold: 3,
});

/**
 * Explicit issue ranges are fixed: confirmations/verdicts 1–5, offer 30–3600
 * seconds. The remaining settings had no documented limits, so these are
 * practical guardrails, not product rules. Positive values are enforced in the
 * database too; the upper bounds keep a typo from disabling a workflow.
 */
export const WORKFLOW_LIMITS = {
  confirmationsNeeded: { min: 1, max: 5 },
  verdictsNeeded: { min: 1, max: 5 },
  offerWindowSeconds: { min: 30, max: 3600 },
  heartbeatMinutes: { min: 1, max: 1440 },
  deliveryMinutes: { min: 1, max: 10080 },
  maxActiveClaims: { min: 1, max: 20 },
  volunteerWindowSeconds: { min: 30, max: 3600 },
  ideaThreshold: { min: 1, max: 100 },
  abandonCheckMinutes: { min: 0, max: 10080 },
  abandonThreshold: { min: 1, max: 100 },
  closeThreshold: { min: 1, max: 100 },
} as const;

const boundedInt = (field: keyof typeof WORKFLOW_LIMITS, label: string) => {
  const { min, max } = WORKFLOW_LIMITS[field];
  return z
    .number({ error: `${label} must be a number.` })
    .int(`${label} must be a whole number.`)
    .min(min, `${label} must be at least ${min}.`)
    .max(max, `${label} must be at most ${max}.`);
};

export const workflowSettingsSchema = z.object({
  confirmationsNeeded: boundedInt("confirmationsNeeded", "Confirmations needed"),
  verdictsNeeded: boundedInt("verdictsNeeded", "Merge verdicts needed"),
  offerWindowSeconds: boundedInt("offerWindowSeconds", "Offer window"),
  heartbeatMinutes: boundedInt("heartbeatMinutes", "Heartbeat window"),
  deliveryMinutes: boundedInt("deliveryMinutes", "Delivery window"),
  maxActiveClaims: boundedInt("maxActiveClaims", "Maximum active claims"),
  volunteerWindowSeconds: boundedInt("volunteerWindowSeconds", "Volunteer window"),
  autoMerge: z.boolean({ error: "Auto-merge must be on or off." }),
  ideaThreshold: boundedInt("ideaThreshold", "Idea threshold"),
  abandonCheckMinutes: boundedInt("abandonCheckMinutes", "Sense check after"),
  abandonThreshold: boundedInt("abandonThreshold", "Abandoned threshold"),
  closeThreshold: boundedInt("closeThreshold", "Close threshold"),
});

/** A stored row, with defaults for a missing row or a test double. */
export function workflowValues(
  row: Partial<ProjectWorkflowValues> | null | undefined,
): ProjectWorkflowValues {
  return {
    confirmationsNeeded: row?.confirmationsNeeded ?? DEFAULT_PROJECT_WORKFLOW.confirmationsNeeded,
    verdictsNeeded: row?.verdictsNeeded ?? DEFAULT_PROJECT_WORKFLOW.verdictsNeeded,
    offerWindowSeconds: row?.offerWindowSeconds ?? DEFAULT_PROJECT_WORKFLOW.offerWindowSeconds,
    heartbeatMinutes: row?.heartbeatMinutes ?? DEFAULT_PROJECT_WORKFLOW.heartbeatMinutes,
    deliveryMinutes: row?.deliveryMinutes ?? DEFAULT_PROJECT_WORKFLOW.deliveryMinutes,
    maxActiveClaims: row?.maxActiveClaims ?? DEFAULT_PROJECT_WORKFLOW.maxActiveClaims,
    volunteerWindowSeconds:
      row?.volunteerWindowSeconds ?? DEFAULT_PROJECT_WORKFLOW.volunteerWindowSeconds,
    autoMerge: row?.autoMerge ?? DEFAULT_PROJECT_WORKFLOW.autoMerge,
    ideaThreshold: row?.ideaThreshold ?? DEFAULT_PROJECT_WORKFLOW.ideaThreshold,
    abandonCheckMinutes: row?.abandonCheckMinutes ?? DEFAULT_PROJECT_WORKFLOW.abandonCheckMinutes,
    abandonThreshold: row?.abandonThreshold ?? DEFAULT_PROJECT_WORKFLOW.abandonThreshold,
    closeThreshold: row?.closeThreshold ?? DEFAULT_PROJECT_WORKFLOW.closeThreshold,
  };
}
