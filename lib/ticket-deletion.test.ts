import { describe, expect, it } from "vitest";
import {
  canDeleteTicket,
  canRestoreTicket,
  deletedSummary,
  deletionCounts,
  deleteSummary,
  restoreSummary,
  retainedSummary,
  TICKET_DELETION_ERRORS,
} from "./ticket-deletion";

describe("delete and restore copy (#692)", () => {
  const counts = { comments: 3, votes: 5 };

  it("says what is kept, with counts when known", () => {
    expect(retainedSummary(counts)).toBe(
      "Its 3 comments, 5 importance marks and history are kept.",
    );
    expect(retainedSummary()).toBe("Its comments, importance marks and history are kept.");
  });

  it("uses singular nouns for a count of one", () => {
    expect(retainedSummary({ comments: 1, votes: 1 })).toContain(
      "1 comment, 1 importance mark and",
    );
    expect(retainedSummary({ comments: 0, votes: 0 })).toContain(
      "0 comments, 0 importance marks",
    );
  });

  it("repeats the same retained sentence in every message", () => {
    const kept = retainedSummary(counts);
    expect(deleteSummary(counts)).toContain(kept);
    expect(deletedSummary(counts)).toContain(kept);
  });

  it("says the issue is hidden, not erased, and how to get it back", () => {
    expect(deleteSummary(counts)).toContain("hidden from regular users");
    expect(deleteSummary(counts)).toContain("View deleted issues");
    expect(deletedSummary(counts)).toContain("can restore it");
  });

  it("mirrors the delete message when restoring", () => {
    expect(restoreSummary(counts)).toContain("3 comments, 5 importance marks and history");
    expect(restoreSummary()).toContain("comments, importance marks and history");
  });

  it("never claims a permanent delete", () => {
    for (const text of [
      deleteSummary(counts),
      deletedSummary(counts),
      restoreSummary(counts),
    ]) {
      expect(text.toLowerCase()).not.toContain("permanent");
    }
  });
});

describe("deletionCounts (#1059)", () => {
  const bucket = (count: number) => ({ count, voters: [] });

  it("counts upvotes only, not the old dislike rows", () => {
    // 3 upvotes and 2 dislikes left over from before downvotes were removed.
    const counts = deletionCounts(4, { likes: bucket(3), dislikes: bucket(2) });
    expect(counts).toEqual({ comments: 4, votes: 3 });
    expect(deletedSummary(counts)).toContain("4 comments, 3 importance marks and history are kept.");
  });

  it("matches an issue that never had a downvote", () => {
    expect(deletionCounts(1, { likes: bucket(1), dislikes: bucket(0) })).toEqual({ comments: 1, votes: 1 });
  });

  it("says 0 votes for an issue with only old dislikes", () => {
    expect(deletionCounts(0, { likes: bucket(0), dislikes: bucket(5) }).votes).toBe(0);
  });
});

describe("canDeleteTicket", () => {
  it("allows the site super admin and an owner or admin of the organization", () => {
    expect(canDeleteTicket("super_admin")).toBe(true);
    expect(canDeleteTicket("user", "owner")).toBe(true);
    expect(canDeleteTicket("user", "admin")).toBe(true);
  });

  it("denies a site-wide admin who is only a member", () => {
    expect(canDeleteTicket("admin")).toBe(false);
    expect(canDeleteTicket("admin", "member")).toBe(false);
  });

  it("denies regular users from deleting tickets", () => {
    expect(canDeleteTicket("user")).toBe(false);
    expect(canDeleteTicket("user", "member")).toBe(false);
  });

  it("denies unauthenticated or invalid roles", () => {
    expect(canDeleteTicket(null)).toBe(false);
    expect(canDeleteTicket(undefined)).toBe(false);
  });
});

describe("canRestoreTicket", () => {
  it("allows the site super admin and an owner or admin of the organization", () => {
    expect(canRestoreTicket("super_admin")).toBe(true);
    expect(canRestoreTicket("user", "admin")).toBe(true);
  });

  it("denies a site-wide admin who is only a member", () => {
    expect(canRestoreTicket("admin", "member")).toBe(false);
  });

  it("denies regular users from restoring deleted tickets", () => {
    expect(canRestoreTicket("user")).toBe(false);
  });

  it("denies unauthenticated or invalid roles", () => {
    expect(canRestoreTicket(null)).toBe(false);
    expect(canRestoreTicket(undefined)).toBe(false);
  });
});

describe("TICKET_DELETION_ERRORS", () => {
  it("has clear and descriptive messages for all failure states", () => {
    expect(TICKET_DELETION_ERRORS.unauthorized).toBe(
      "Only an owner or admin of this organization can delete issues",
    );
    expect(TICKET_DELETION_ERRORS.unauthorizedRestore).toBe(
      "Only an owner or admin of this organization can restore issues",
    );
    expect(TICKET_DELETION_ERRORS.invalidId).toBe("Invalid issue ID");
    expect(TICKET_DELETION_ERRORS.notFound).toBe("Issue not found");
    expect(TICKET_DELETION_ERRORS.alreadyDeleted).toBe(
      "Issue is already deleted",
    );
    expect(TICKET_DELETION_ERRORS.notDeleted).toBe("Issue is not deleted");
    expect(TICKET_DELETION_ERRORS.failed).toBe(
      "Could not delete issue. Please try again.",
    );
    expect(TICKET_DELETION_ERRORS.failedRestore).toBe(
      "Could not restore issue. Please try again.",
    );
  });
});
