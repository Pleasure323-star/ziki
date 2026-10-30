import type { Prisma, PrismaClient } from "@prisma/client";
import { stageEntryRoute } from "@/lib/stage-entry-route";

type Db = PrismaClient | Prisma.TransactionClient;

/** Where a new comment goes: under one stage entry, under a comment, or on the issue itself. */
export type CommentPlacementInput = {
  confirmationId?: string;
  bidId?: string;
  testVerdictId?: string;
  mergeReviewId?: string;
  parentId?: string;
};

export type CommentPlacement = {
  confirmationId: string | null;
  bidId: string | null;
  testVerdictId: string | null;
  mergeReviewId: string | null;
  parentId: string | null;
  /** Whom the comment answers: the entry's or the parent comment's author, for notifications. */
  parentAuthorId: string | null;
};

/** Why a comment can't go where it was sent. `code` is the agent API's error code. */
export class CommentPlacementError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly entryRoute: string | null = null,
  ) {
    super(message);
  }
}

/**
 * The one rule for where a comment may go, for people and agents alike:
 *
 * - A reply to one stage entry (a confirmation, a bid, a test verdict or a
 *   merge review), at any stage.
 * - A comment on the issue itself, or a reply to one, only while the issue is
 *   Open (status `open`). At every other stage what anyone says is an entry.
 */
export async function placeComment(
  db: Db,
  bug: { id: string; status: string; pullRequestUrl?: string | null },
  input: CommentPlacementInput,
): Promise<CommentPlacement> {
  const placement: CommentPlacement = {
    confirmationId: input.confirmationId ?? null,
    bidId: input.bidId ?? null,
    testVerdictId: input.testVerdictId ?? null,
    mergeReviewId: input.mergeReviewId ?? null,
    parentId: input.parentId ?? null,
    parentAuthorId: null,
  };
  const entries = [placement.confirmationId, placement.bidId, placement.testVerdictId, placement.mergeReviewId].filter(Boolean);
  if (entries.length > 1 || (entries.length === 1 && placement.parentId)) {
    throw new CommentPlacementError(
      422,
      "one_place",
      "Send one place for the comment: one of confirmationId, bidId, testVerdictId, mergeReviewId or parentId.",
    );
  }

  if (placement.confirmationId) {
    const entry = await db.issueConfirmation.findFirst({ where: { id: placement.confirmationId, bugId: bug.id }, select: { onBehalfOfUserId: true } });
    if (!entry) throw new CommentPlacementError(422, "not_found", "That confirmation is not on this issue.");
    return { ...placement, parentAuthorId: entry.onBehalfOfUserId };
  }
  if (placement.bidId) {
    const bid = await db.issueBid.findFirst({ where: { id: placement.bidId, bugId: bug.id }, select: { beneficiaryUserId: true } });
    if (!bid) throw new CommentPlacementError(422, "not_found", "That bid is not on this issue.");
    return { ...placement, parentAuthorId: bid.beneficiaryUserId };
  }
  if (placement.testVerdictId) {
    const verdict = await db.testVerdict.findFirst({ where: { id: placement.testVerdictId, bugId: bug.id }, select: { onBehalfOfUserId: true } });
    if (!verdict) throw new CommentPlacementError(422, "not_found", "That test verdict is not on this issue.");
    return { ...placement, parentAuthorId: verdict.onBehalfOfUserId };
  }
  if (placement.mergeReviewId) {
    const review = await db.mergeReview.findFirst({ where: { id: placement.mergeReviewId, bugId: bug.id }, select: { onBehalfOfUserId: true } });
    if (!review) throw new CommentPlacementError(422, "not_found", "That merge review is not on this issue.");
    return { ...placement, parentAuthorId: review.onBehalfOfUserId };
  }

  if (bug.status !== "open") {
    const entry = stageEntryRoute(bug);
    throw new CommentPlacementError(
      409,
      "use_stage_entry",
      entry
        ? `This issue takes comments only while it is Open. At this stage, say it as ${entry.label} (${entry.route}, with a summary and a description), or reply to an entry with its id.`
        : "This issue takes comments only while it is Open. Reply to an entry with its id instead.",
      entry?.route ?? null,
    );
  }
  if (placement.parentId) {
    // Replies are one level deep, under a comment on the issue itself.
    const parent = await db.comment.findFirst({
      where: {
        id: placement.parentId,
        bugId: bug.id,
        deletedAt: null,
        parentId: null,
        confirmationId: null,
        bidId: null,
        testVerdictId: null,
        mergeReviewId: null,
      },
      select: { authorId: true },
    });
    if (!parent) throw new CommentPlacementError(422, "not_found", "That comment is not a comment on this issue you can reply to.");
    return { ...placement, parentAuthorId: parent.authorId };
  }
  return placement;
}
