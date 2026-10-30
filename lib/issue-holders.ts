import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type Db = PrismaClient | Prisma.TransactionClient;

/** How an agent got an issue. */
export type HoldVia = "bid" | "assigned" | "offer" | "claim";

/** One agent's hold on an issue, from its claim: who, for whom, how and when. */
export type IssueHold = {
  id: string;
  agentName: string;
  personName: string;
  via: HoldVia;
  /** Who handed it out, when a person or manager did. */
  dispatcherName: string | null;
  status: "offered" | "active" | "released";
  offeredAt: Date | null;
  claimedAt: Date | null;
  releasedAt: Date | null;
  releaseReason: string | null;
  deliverBy: Date | null;
};

/** A release reason, in plain words. */
export function releaseReasonText(reason: string | null): string {
  switch (reason) {
    case "silence":
      return "went silent";
    case "deadline":
      return "missed the deadline";
    case "expired":
      return "didn't accept the offer in time";
    case "undo":
      return "was undone";
    case "agent":
      return "let it go";
    case "resolved":
      return "the issue was resolved";
    case "closed":
      return "the issue was closed";
    case "owner_unresponsive":
      return "its owner didn't answer";
    default:
      return "released";
  }
}

/**
 * Everyone who has held or been offered the issue, newest first. The claim is
 * the record of who has the work (`IssueClaim`); a linked bid means it was won
 * by bidding, a dispatcher that someone assigned it, an offer that the agent
 * accepted one.
 */
export async function issueHolds(bugId: string, db: Db = prisma): Promise<IssueHold[]> {
  const claims = await db.issueClaim.findMany({
    where: { bugId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      status: true,
      offeredAt: true,
      claimedAt: true,
      releasedAt: true,
      releaseReason: true,
      deliverBy: true,
      agent: { select: { name: true } },
      beneficiary: { select: { name: true } },
      dispatcher: { select: { name: true } },
      awardedBid: { select: { id: true } },
    },
  });
  return claims.map((claim) => ({
    id: claim.id,
    agentName: claim.agent.name,
    personName: claim.beneficiary.name,
    via: claim.awardedBid ? "bid" : claim.dispatcher ? "assigned" : claim.offeredAt ? "offer" : "claim",
    dispatcherName: claim.dispatcher?.name ?? null,
    status: claim.releasedAt ? "released" : claim.status,
    offeredAt: claim.offeredAt,
    claimedAt: claim.claimedAt,
    releasedAt: claim.releasedAt,
    releaseReason: claim.releaseReason,
    deliverBy: claim.deliverBy,
  }));
}
