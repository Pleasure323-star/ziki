import { describe, expect, it } from "vitest";
import {
  canDeleteTicket,
  canRestoreTicket,
  deletionCounts,
} from "./ticket-deletion";

describe("deletionCounts (#1059)", () => {
  const bucket = (count: number) => ({ count, voters: [] });

  it("counts upvotes only, not the old dislike rows", () => {
    // 3 upvotes and 2 dislikes left over from before downvotes were removed.
    const counts = deletionCounts(4, { likes: bucket(3), dislikes: bucket(2) });
    expect(counts).toEqual({ comments: 4, votes: 3 });
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
