/**
 * Where a merged fix has got to on its way to production: dev → staging → main.
 * Shown as three chips per issue on the merge history page (see components/merge-path.tsx).
 */
export const DEPLOY_STAGES = ["dev", "staging", "main"] as const;
export type DeployStage = (typeof DEPLOY_STAGES)[number];

export function isDeployStage(value: unknown): value is DeployStage {
  return typeof value === "string" && (DEPLOY_STAGES as readonly string[]).includes(value);
}

/**
 * The furthest stage an issue has reached, or null when it has not been merged.
 *
 * TODO(merger fields): once the merger agent records the real stage on the
 * issue, pass it as `recorded` and it wins. Until then the only thing we know
 * is that the issue is live (`status === "resolved"`), so the fix has at least reached dev.
 */
export function deployStageOf(
  status: string | null | undefined,
  recorded?: string | null,
): DeployStage | null {
  if (isDeployStage(recorded)) return recorded;
  if (status === "resolved") return "dev";
  return null;
}

/** True when `stage` is at or before `furthest` in the dev → staging → main order. */
export function stageReached(stage: DeployStage, furthest: DeployStage): boolean {
  return DEPLOY_STAGES.indexOf(stage) <= DEPLOY_STAGES.indexOf(furthest);
}
