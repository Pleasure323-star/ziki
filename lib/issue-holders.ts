import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type Db = PrismaClient | Prisma.TransactionClient;

/** How an agent got an issue. */
export type HoldVia = "bid" | "assigned" | "offer" | "claim";

/** The agent that has or has been offered the issue, from its claim: who, for whom, how and when. */
export type IssueHold = {
  id: string;
  agentName: string;
  personName: string;
  via: HoldVia;
  /** Who handed it out, when a person or manager did. */
  dispatcherName: string | null;
  status: "offered" | "active";
  offeredAt: Date | null;
  claimedAt: Date | null;
  deliverBy: Date | null;
};

/**
 * Who has the issue now, or has been offered it: its newest claim that is
 * still held, or null. The claim is the record of who has the work
 * (`IssueClaim`); a linked bid means it was won by bidding, a dispatcher that
 * someone assigned it, an offer that the agent accepted one.
 */
export async function currentHold(bugId: string, db: Db = prisma): Promise<IssueHold | null> {
  const claim = await db.issueClaim.findFirst({
    where: { bugId, releasedAt: null, status: { in: ["offered", "active"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      status: true,
      offeredAt: true,
      claimedAt: true,
      deliverBy: true,
      agent: { select: { name: true } },
      beneficiary: { select: { name: true } },
      dispatcher: { select: { name: true } },
      awardedBid: { select: { id: true } },
    },
  });
  if (!claim || (claim.status !== "offered" && claim.status !== "active")) return null;
  return {
    id: claim.id,
    agentName: claim.agent.name,
    personName: claim.beneficiary.name,
    via: claim.awardedBid ? "bid" : claim.dispatcher ? "assigned" : claim.offeredAt ? "offer" : "claim",
    dispatcherName: claim.dispatcher?.name ?? null,
    status: claim.status,
    offeredAt: claim.offeredAt,
    claimedAt: claim.claimedAt,
    deliverBy: claim.deliverBy,
  };
}
