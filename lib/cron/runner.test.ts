import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSweepOffers = vi.hoisted(() => vi.fn());
const mockSweepJobReviewOffers = vi.hoisted(() => vi.fn());
const mockSweepClaims = vi.hoisted(() => vi.fn());
const mockSweepOrphans = vi.hoisted(() => vi.fn());
const mockDispatch = vi.hoisted(() => vi.fn());
const mockPruneAgent = vi.hoisted(() => vi.fn());
const mockSweepAttachments = vi.hoisted(() => vi.fn());
const mockSweepDraftStructuring = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ logger: mockLogger }));
vi.mock("@/lib/agent-api/offer", () => ({ sweepExpiredOffers: mockSweepOffers }));
vi.mock("@/lib/jobs/review", () => ({ sweepJobReviewOffers: mockSweepJobReviewOffers }));
vi.mock("@/lib/agent-api/availability", () => ({ sweepStaleClaims: mockSweepClaims }));
vi.mock("@/lib/orphaned-issues", () => ({ sweepOrphanedIssues: mockSweepOrphans }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchDueDeliveries: mockDispatch }));
vi.mock("@/lib/agent-retention", () => ({ pruneAgentRows: mockPruneAgent }));
vi.mock("@/lib/attachment-retention", () => ({ sweepOrphanedAttachments: mockSweepAttachments }));
vi.mock("@/lib/cron/draft-structuring", () => ({ sweepUndraftedIdeas: mockSweepDraftStructuring }));

import {
  runPlatformSweeps,
  recordSweepFailure,
  recordSweepSuccess,
  getConsecutiveFailures,
  resetConsecutiveFailures,
  FAILURE_ALERT_THRESHOLD,
} from "./runner";

describe("runPlatformSweeps (#647)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetConsecutiveFailures();

    mockSweepOffers.mockResolvedValue({ expired: 2 });
    mockSweepJobReviewOffers.mockResolvedValue({ expired: 1, offered: 3 });
    mockSweepClaims.mockResolvedValue({ released: 1 });
    mockSweepOrphans.mockResolvedValue({ reopened: 2 });
    mockSweepDraftStructuring.mockResolvedValue({ structured: 3, flagged: 1, skipped: 0, failed: 0, errors: [] });
    mockDispatch.mockResolvedValue(4);
    mockPruneAgent.mockResolvedValue({
      pairings: 1,
      deliveries: 2,
      events: 3,
      auditEvents: 4,
      rateLimitHits: 5,
    });
    mockSweepAttachments.mockResolvedValue({
      unlinked: 6,
      deletedParents: 7,
      total: 13,
    });
  });

  it("runs all sweeps, logs the counts, and returns structured result", async () => {
    const result = await runPlatformSweeps();

    expect("skipped" in result).toBe(false);
    if (!("skipped" in result)) {
      expect(result.sweeps.offers).toEqual({ status: "ok", expired: 2 });
      expect(result.sweeps.jobReviewOffers).toEqual({ status: "ok", expired: 1, offered: 3 });
      expect(result.sweeps.claims).toEqual({ status: "ok", released: 1 });
      expect(result.sweeps.orphanedIssues).toEqual({ status: "ok", reopened: 2 });
      // Bids are awarded only by manager agents: there is no bid sweep (#bids-only-offers).
      expect(result.sweeps).not.toHaveProperty("bids");
      expect(result.sweeps.draftStructuring).toEqual({
        status: "ok",
        structured: 3,
        flagged: 1,
        skipped: 0,
        failed: 0,
      });
      expect(result.sweeps).not.toHaveProperty("promotions");
      expect(result.sweeps.deliveries).toEqual({ status: "ok", processed: 4 });
      expect(result.sweeps.retention).toEqual({
        status: "ok",
        pruned: {
          pairings: 1,
          deliveries: 2,
          events: 3,
          auditEvents: 4,
          rateLimitHits: 5,
          unlinkedUploads: 6,
          deletedParentAttachments: 7,
        },
      });
      expect(result.timestamp).toBeDefined();
    }

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("[cron] Platform sweeps finished"),
      expect.any(Object),
    );
  });

  it("isolates errors per sweep so one failing sweep does not abort the others", async () => {
    mockDispatch.mockRejectedValueOnce(new Error("Network timeout during webhooks"));

    const result = await runPlatformSweeps();

    expect("skipped" in result).toBe(false);
    if (!("skipped" in result)) {
      expect(result.sweeps.offers).toEqual({ status: "ok", expired: 2 });
      expect(result.sweeps.jobReviewOffers).toEqual({ status: "ok", expired: 1, offered: 3 });
      expect(result.sweeps.claims).toEqual({ status: "ok", released: 1 });
      expect(result.sweeps.deliveries).toEqual({
        status: "error",
        error: "Network timeout during webhooks",
      });
      expect(result.sweeps.retention.status).toBe("ok");
    }
  });

  it("runs orphan recovery even when claim sweeping fails and isolates recovery failures", async () => {
    mockSweepClaims.mockRejectedValueOnce(new Error("claim sweep failed"));
    mockSweepOrphans.mockRejectedValueOnce(new Error("recovery failed"));
    const result = await runPlatformSweeps();
    expect(mockSweepOrphans).toHaveBeenCalledOnce();
    if (!("skipped" in result)) {
      expect(result.sweeps.orphanedIssues).toEqual({ status: "error", error: "recovery failed" });
      expect(result.sweeps.deliveries.status).toBe("ok");
      expect(result.sweeps.retention.status).toBe("ok");
    }
    expect(getConsecutiveFailures("orphanedIssues")).toBe(1);
    await runPlatformSweeps();
    expect(getConsecutiveFailures("orphanedIssues")).toBe(0);
  });

  it("alerts with [CRON_ALERT] when a sweep fails repeatedly at or above threshold", async () => {
    const err = new Error("Database deadlocked");

    recordSweepFailure("claims", err);
    expect(getConsecutiveFailures("claims")).toBe(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      "[cron] Sweep 'claims' failed:",
      err,
    );

    recordSweepFailure("claims", err);
    expect(getConsecutiveFailures("claims")).toBe(2);

    // 3rd failure reaches threshold
    recordSweepFailure("claims", err);
    expect(getConsecutiveFailures("claims")).toBe(FAILURE_ALERT_THRESHOLD);
    expect(mockLogger.error).toHaveBeenCalledWith(
      `[CRON_ALERT] Sweep 'claims' failed ${FAILURE_ALERT_THRESHOLD} consecutive times:`,
      err,
    );

    // Success resets count
    recordSweepSuccess("claims");
    expect(getConsecutiveFailures("claims")).toBe(0);
  });
});
