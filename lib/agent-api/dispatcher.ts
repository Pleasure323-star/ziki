import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { IssueApiError } from "@/lib/agent-api/errors";
import { isConfirmed } from "@/lib/agent-api/confirmations";
import { publish } from "@/lib/agent-api/events";
import { offerNext, scheduleOfferExpiry, sweepExpiredOffers } from "@/lib/agent-api/offer";
import { awardBid } from "@/lib/agent-api/bid";
import { notifyClaimOffered } from "@/lib/agent-notifications";
import { workflowFor } from "@/lib/workflow";

const id = z.string().trim().min(1).max(191);

/**
 * Dispatcher assignment policy.
 */
export type DispatcherPolicy = "offer_only" | "auto_award" | "direct_assign";

export const dispatcherPolicySchema = z.enum(["offer_only", "auto_award", "direct_assign"]);

export const dispatcherConfigSchema = z.object({
  projectId: id.optional(),
  policy: dispatcherPolicySchema.optional(),
  autoAwardAfterHours: z.number().int().min(1).max(168).optional(),
  maxOffersPerRun: z.number().int().min(1).max(100).optional(),
});

export type DispatcherConfig = z.infer<typeof dispatcherConfigSchema>;

/**
 * A ready issue: confirmed, has 3+ upvotes, and has no active claim.
 */
export type ReadyIssue = {
  id: string;
  number: number;
  title: string;
  projectId: string;
  areaId: string | null;
  voteCount: number;
  assigneeId: string | null;
  createdAt: Date;
};

export const MAX_READY_ISSUES_LIMIT = 500;

/**
 * Scan for ready issues in a project.
 */
export async function findReadyIssues(
  agent: AgentContext,
  projectId: string,
  limit = 50,
  options?: { hasBids?: boolean; bidCreatedBefore?: Date }
): Promise<ReadyIssue[]> {
  requireLevel(agent, "manager");

  const safeLimit = Number.isFinite(limit) && limit > 0
    ? Math.min(Math.floor(limit), MAX_READY_ISSUES_LIMIT)
    : 50;

  const workflow = await workflowFor(projectId);
  const offerCutoff = new Date(Date.now() - workflow.offerWindowSeconds * 1000);

  const ready: ReadyIssue[] = [];
  let cursor: string | undefined;
  while (ready.length < safeLimit) {
    const issues = await prisma.bug.findMany({
      where: {
        tenantId: agent.tenantId,
        projectId,
        isDeleted: false,
        status: "open",
        claims: {
          none: {
            releasedAt: null,
            OR: [
              { status: "active" },
              { status: "offered", offeredAt: { gt: offerCutoff } },
            ],
          },
        },
        ...(options?.hasBids !== undefined
          ? options.hasBids
            ? {
                bids: {
                  some: {
                    withdrawnAt: null,
                    awardedAt: null,
                    ...(options.bidCreatedBefore ? { createdAt: { lte: options.bidCreatedBefore } } : {}),
                  },
                },
              }
            : { bids: { none: { withdrawnAt: null, awardedAt: null } } }
          : {}),
      },
      select: {
        id: true,
        number: true,
        title: true,
        projectId: true,
        areaId: true,
        voteCount: true,
        assigneeId: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 50,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    // Filter to only confirmed issues
    for (let offset = 0; offset < issues.length && ready.length < safeLimit; offset += 10) {
      const confirmed = await Promise.all(
        issues.slice(offset, offset + 10).map(async (issue) => ({
          ...issue,
          confirmed: await isConfirmed(issue.id),
        }))
      );
      ready.push(...confirmed.filter((issue) => issue.confirmed));
    }
    if (issues.length < 50) break;
    cursor = issues[issues.length - 1].id;
  }

  return ready.slice(0, safeLimit);
}

/**
 * Dispatcher operation result.
 */
export type DispatcherResult = {
  offered: number;
  awarded: number;
  skipped: number;
  errors: Array<{ issueId: string; error: string }>;
};

/**
 * Automatically offer ready issues to eligible candidates.
 */
export async function dispatchReadyIssues(
  agent: AgentContext,
  projectId: string,
  config: DispatcherConfig = {}
): Promise<DispatcherResult> {
  requireLevel(agent, "manager");

  const {
    policy = "offer_only",
    autoAwardAfterHours,
    maxOffersPerRun = 10,
  } = config;

  await sweepExpiredOffers(agent.tenantId, projectId);

  let readyIssues: ReadyIssue[] = [];
  if (policy === "auto_award") {
    // In auto_award mode, prioritize ready issues with pending bids that have
    // aged enough to be eligible for auto-award (if autoAwardAfterHours is set).
    // This prevents recent ineligible bids from consuming the run limit and starving
    // aged bids on newer issues or unbid issues.
    const bidCreatedBefore = autoAwardAfterHours
      ? new Date(Date.now() - autoAwardAfterHours * 3_600_000)
      : undefined;

    const bidIssues = await findReadyIssues(agent, projectId, maxOffersPerRun, {
      hasBids: true,
      bidCreatedBefore,
    });
    readyIssues.push(...bidIssues);
    if (readyIssues.length < maxOffersPerRun) {
      const remainingLimit = maxOffersPerRun - readyIssues.length;
      const seenIds = new Set(readyIssues.map((i) => i.id));
      // Filter the fill scan to issues without bids so young ineligible bids do not
      // consume remaining capacity and starve unbid issues that can be offered.
      const unbidIssues = await findReadyIssues(agent, projectId, remainingLimit, {
        hasBids: false,
      });
      for (const issue of unbidIssues) {
        if (!seenIds.has(issue.id) && readyIssues.length < maxOffersPerRun) {
          readyIssues.push(issue);
        }
      }
    }
  } else {
    readyIssues = await findReadyIssues(agent, projectId, maxOffersPerRun);
  }

  const result: DispatcherResult = {
    offered: 0,
    awarded: 0,
    skipped: 0,
    errors: [],
  };

  for (const issue of readyIssues) {
    try {
      if (policy === "direct_assign") {
        // Directly assign to top candidate without offering
        await assignDirectly(agent, issue);
        result.awarded++;
      } else {
        // Check for existing bids first
        const bids = await prisma.issueBid.findMany({
          where: {
            bugId: issue.id,
            withdrawnAt: null,
            awardedAt: null,
          },
          select: {
            id: true,
            agentId: true,
            beneficiaryUserId: true,
            createdAt: true,
            bug: { select: { reporterId: true } },
          },
          orderBy: { createdAt: "asc" },
        });

        if (bids.length > 0) {
          // Pending bids belong to the reporter. Only auto_award may close one,
          // and only once the reporter has had autoAwardAfterHours to pick.
          const oldest = bids[0];
          const waitedLongEnough =
            !autoAwardAfterHours ||
            oldest.createdAt.getTime() <= Date.now() - autoAwardAfterHours * 3_600_000;
          if (policy === "auto_award" && waitedLongEnough) {
            if (!oldest.bug.reporterId) throw new IssueApiError(409, "Issue has no reporter to award the bid.");
            await awardBid({ id: oldest.bug.reporterId }, oldest.id, agent);
            result.awarded++;
          } else {
            result.skipped++;
          }
        } else {
          // No bids: offer to the top-ranked candidate.
          if (await offerIssue(agent, issue)) result.offered++;
          else result.skipped++;
        }
      }
    } catch (error) {
      result.errors.push({
        issueId: issue.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

/**
 * Offer an issue to the next eligible candidate.
 */
async function offerIssue(
  agent: AgentContext,
  issue: ReadyIssue
): Promise<boolean> {
  const offerResult = await offerNext(prisma, agent, {
    id: issue.id,
    projectId: issue.projectId,
    title: issue.title,
    assigneeId: issue.assigneeId,
    areaId: issue.areaId,
  });

  if (offerResult) {
    notifyClaimOffered({
      id: offerResult.claim.id,
      bugId: issue.id,
      bugTitle: offerResult.bugTitle,
      beneficiaryUserId: offerResult.beneficiaryUserId,
    });

    scheduleOfferExpiry(offerResult.claim.id);
  }
  return Boolean(offerResult);
}

/**
 * Directly assign an issue to the top candidate (bypass bidding).
 */
async function assignDirectly(
  agent: AgentContext,
  issue: ReadyIssue
): Promise<void> {
  const offerResult = await offerNext(prisma, agent, {
    id: issue.id,
    projectId: issue.projectId,
    title: issue.title,
    assigneeId: issue.assigneeId,
    areaId: issue.areaId,
  });

  if (!offerResult) {
    throw new IssueApiError(409, "No eligible candidate available for direct assignment.");
  }

  // Accept the offer immediately to create an active claim
  const claim = await prisma.issueClaim.update({
    where: { id: offerResult.claim.id },
    data: {
      status: "active",
      claimedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });

  await prisma.bug.update({
    where: { id: issue.id },
    data: {
      assigneeId: offerResult.beneficiaryUserId,
      status: "in_progress",
    },
  });

  await publish(prisma, {
    tenantId: agent.tenantId,
    type: "claim.accepted",
    actorAgentId: agent.agentId,
    bugId: issue.id,
    payload: {
      claimId: claim.id,
      issueId: issue.id,
      projectId: issue.projectId,
      beneficiaryUserId: offerResult.beneficiaryUserId,
    },
  });
}

/**
 * Get dispatcher metrics for a project.
 */
export async function getDispatcherMetrics(
  agent: AgentContext,
  projectId: string
): Promise<{
  readyIssues: number;
  activeClaims: number;
  pendingOffers: number;
  openBids: number;
}> {
  requireLevel(agent, "manager");

  const workflow = await workflowFor(projectId);
  const offerCutoff = new Date(Date.now() - workflow.offerWindowSeconds * 1000);

  const [readyCount, activeClaims, pendingOffers, openBids] = await Promise.all([
    findReadyIssues(agent, projectId, 100).then((issues) => issues.length),
    prisma.issueClaim.count({
      where: {
        bug: { tenantId: agent.tenantId, projectId },
        status: "active",
        releasedAt: null,
      },
    }),
    prisma.issueClaim.count({
      where: {
        bug: { tenantId: agent.tenantId, projectId },
        status: "offered",
        releasedAt: null,
        offeredAt: { gt: offerCutoff },
      },
    }),
    prisma.issueBid.count({
      where: {
        bug: { tenantId: agent.tenantId, projectId },
        withdrawnAt: null,
        awardedAt: null,
      },
    }),
  ]);

  return {
    readyIssues: readyCount,
    activeClaims,
    pendingOffers,
    openBids,
  };
}
