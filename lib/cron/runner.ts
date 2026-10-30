import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { sweepExpiredOffers } from "@/lib/agent-api/offer";
import { sweepJobReviewOffers } from "@/lib/jobs/review";
import { sweepStaleClaims } from "@/lib/agent-api/availability";
import { dispatchDueDeliveries } from "@/lib/webhooks/deliver";
import { pruneAgentRows, type AgentRetentionCounts } from "@/lib/agent-retention";
import { sweepOrphanedAttachments } from "@/lib/attachment-retention";
import { sweepOrphanedIssues } from "@/lib/orphaned-issues";
import { sweepPendingBids } from "@/lib/cron/bids";
import { sweepUndraftedIdeas } from "@/lib/cron/draft-structuring";

export const FAILURE_ALERT_THRESHOLD = 3;
const consecutiveFailures = new Map<string, number>();

export function recordSweepFailure(sweepName: string, error: unknown): void {
  const count = (consecutiveFailures.get(sweepName) ?? 0) + 1;
  consecutiveFailures.set(sweepName, count);
  if (count >= FAILURE_ALERT_THRESHOLD) {
    logger.error(`[CRON_ALERT] Sweep '${sweepName}' failed ${count} consecutive times:`, error);
  } else {
    logger.error(`[cron] Sweep '${sweepName}' failed:`, error);
  }
}

export function recordSweepSuccess(sweepName: string): void {
  consecutiveFailures.set(sweepName, 0);
}

export function getConsecutiveFailures(sweepName: string): number {
  return consecutiveFailures.get(sweepName) ?? 0;
}

export function resetConsecutiveFailures(): void {
  consecutiveFailures.clear();
}

export type RetentionPruneCounts = AgentRetentionCounts & {
  unlinkedUploads: number;
  deletedParentAttachments: number;
};

export type PlatformSweepsResult = {
  timestamp: string;
  sweeps: {
    offers: { status: "ok" | "error"; expired?: number; error?: string };
    jobReviewOffers: { status: "ok" | "error"; expired?: number; offered?: number; error?: string };
    claims: { status: "ok" | "error"; released?: number; offered?: number; error?: string };
    orphanedIssues: { status: "ok" | "error"; reopened?: number; error?: string };
    bids: { status: "ok" | "error"; invited?: number; assigned?: number; lapsed?: number; error?: string };
    draftStructuring: {
      status: "ok" | "error";
      structured?: number;
      flagged?: number;
      skipped?: number;
      failed?: number;
      error?: string;
    };
    deliveries: { status: "ok" | "error"; processed?: number; error?: string };
    retention: {
      status: "ok" | "error";
      pruned?: RetentionPruneCounts;
      error?: string;
    };
  };
};

let sweepInProgress = false;

/**
 * Runs the due sweeps on schedule (#647):
 * - Offer expiry (due-date sweep)
 * - Job-review offer expiry and recovery
 * - Stale claim release (inactivity & deadline)
 * - Reopen unassigned in-progress issues without live claims or linked fixes
 * - Webhook dispatch (lease-guarded)
 * - Retention prunes (agent rows & orphaned attachments)
 *
 * Each sweep is independent, idempotent, and lease-guarded so that a failure in one
 * does not abort the others and concurrent runs never double-process rows.
 */
export async function runPlatformSweeps(): Promise<PlatformSweepsResult | { skipped: true; reason: string }> {
  if (sweepInProgress) {
    return { skipped: true, reason: "A sweep run is already in progress on this instance." };
  }
  sweepInProgress = true;
  try {
    const timestamp = new Date().toISOString();
    const result: PlatformSweepsResult = {
      timestamp,
      sweeps: {
        offers: { status: "ok" },
        jobReviewOffers: { status: "ok" },
        claims: { status: "ok" },
        orphanedIssues: { status: "ok" },
        bids: { status: "ok" },
        draftStructuring: { status: "ok" },
        deliveries: { status: "ok" },
        retention: { status: "ok" },
      },
    };

    // 1. Expired Offers
    try {
      const res = await sweepExpiredOffers();
      recordSweepSuccess("offers");
      result.sweeps.offers = { status: "ok", expired: res.expired };
    } catch (err) {
      recordSweepFailure("offers", err);
      result.sweeps.offers = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }

    // 1b. Job Review Offers
    try {
      const res = await sweepJobReviewOffers();
      recordSweepSuccess("jobReviewOffers");
      result.sweeps.jobReviewOffers = { status: "ok", expired: res.expired, offered: res.offered };
    } catch (err) {
      recordSweepFailure("jobReviewOffers", err);
      result.sweeps.jobReviewOffers = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // 2. Stale Claims
    try {
      const res = await sweepStaleClaims();
      recordSweepSuccess("claims");
      result.sweeps.claims = { status: "ok", released: res.released, offered: res.offered };
    } catch (err) {
      recordSweepFailure("claims", err);
      result.sweeps.claims = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }

    // 2b. Issues that have no claim for the stale-claim sweep to find (#623).
    try {
      const res = await sweepOrphanedIssues();
      recordSweepSuccess("orphanedIssues");
      result.sweeps.orphanedIssues = { status: "ok", reopened: res.reopened };
    } catch (err) {
      recordSweepFailure("orphanedIssues", err);
      result.sweeps.orphanedIssues = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }

    // 2c. Fair Bid Auto-Assignment Handshake
    try {
      const res = await sweepPendingBids();
      recordSweepSuccess("bids");
      result.sweeps.bids = {
        status: "ok",
        invited: res.invited,
        assigned: res.assigned,
        lapsed: res.lapsed,
      };
    } catch (err) {
      recordSweepFailure("bids", err);
      result.sweeps.bids = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // 2d. Draft Idea Auto-Structuring (#682, #685)
    try {
      const res = await sweepUndraftedIdeas();
      recordSweepSuccess("draftStructuring");
      result.sweeps.draftStructuring = {
        status: "ok",
        structured: res.structured,
        flagged: res.flagged,
        skipped: res.skipped,
        failed: res.failed,
      };
    } catch (err) {
      recordSweepFailure("draftStructuring", err);
      result.sweeps.draftStructuring = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // 4. Webhook Deliveries
    try {
      const processed = await dispatchDueDeliveries();
      recordSweepSuccess("deliveries");
      result.sweeps.deliveries = { status: "ok", processed };
    } catch (err) {
      recordSweepFailure("deliveries", err);
      result.sweeps.deliveries = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }

    // 5. Retention Prunes
    try {
      const agentPrune = await pruneAgentRows(prisma, { sweep: true });
      const attachmentPrune = await sweepOrphanedAttachments(prisma, { sweep: true });
      recordSweepSuccess("retention");
      result.sweeps.retention = {
        status: "ok",
        pruned: {
          ...agentPrune,
          unlinkedUploads: attachmentPrune.unlinked,
          deletedParentAttachments: attachmentPrune.deletedParents,
        },
      };
    } catch (err) {
      recordSweepFailure("retention", err);
      result.sweeps.retention = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }

    logger.info("[cron] Platform sweeps finished", {
      offers: result.sweeps.offers,
      jobReviewOffers: result.sweeps.jobReviewOffers,
      claims: result.sweeps.claims,
      orphanedIssues: result.sweeps.orphanedIssues,
      draftStructuring: result.sweeps.draftStructuring,
      deliveries: result.sweeps.deliveries,
      retention: result.sweeps.retention,
    });

    return result;
  } finally {
    sweepInProgress = false;
  }
}
