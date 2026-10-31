import { describe, expect, it } from "vitest";
import {
  canEditTicket,
  getChangedEditFields,
  getProofLinkChanges,
} from "./ticket-editing";

describe("canEditTicket", () => {
  it("allows the issue reporter to edit their own issue", () => {
    expect(
      canEditTicket({
        actorId: "user_123",
        actorRole: "user",
        reporterId: "user_123",
      }),
    ).toBe(true);
  });

  it("allows an owner or admin of the organization to edit any issue", () => {
    expect(
      canEditTicket({
        actorId: "admin_456",
        actorRole: "user",
        membershipRole: "owner",
        reporterId: "user_123",
      }),
    ).toBe(true);
  });

  it("denies a site-wide admin who is only a member and not the reporter", () => {
    expect(
      canEditTicket({
        actorId: "admin_456",
        actorRole: "admin",
        membershipRole: "member",
        reporterId: "user_123",
      }),
    ).toBe(false);
  });

  it("allows super admins to edit any issue", () => {
    expect(
      canEditTicket({
        actorId: "super_admin_789",
        actorRole: "super_admin",
        reporterId: "user_123",
      }),
    ).toBe(true);
  });

  it("denies other users who are neither the reporter nor an admin", () => {
    expect(
      canEditTicket({
        actorId: "user_other",
        actorRole: "user",
        reporterId: "user_123",
      }),
    ).toBe(false);
  });

  it("denies unauthenticated users (null or undefined actorId)", () => {
    expect(
      canEditTicket({
        actorId: null,
        actorRole: null,
        reporterId: "user_123",
      }),
    ).toBe(false);

    expect(
      canEditTicket({
        actorId: undefined,
        actorRole: undefined,
        reporterId: "user_123",
      }),
    ).toBe(false);
  });
});

describe("getChangedEditFields", () => {
  it("detects when both title and description changed", () => {
    const existing = { title: "Old title", description: "Old description text" };
    const updated = { title: "New title", description: "New description text" };
    expect(getChangedEditFields(existing, updated)).toEqual([
      "title",
      "description",
    ]);
  });

  it("detects when only title changed", () => {
    const existing = { title: "Old title", description: "Same description" };
    const updated = { title: "New title", description: "Same description" };
    expect(getChangedEditFields(existing, updated)).toEqual(["title"]);
  });

  it("detects when only description changed", () => {
    const existing = { title: "Same title", description: "Old description" };
    const updated = { title: "Same title", description: "New description" };
    expect(getChangedEditFields(existing, updated)).toEqual(["description"]);
  });

  it("returns empty array when neither changed", () => {
    const existing = { title: "Same title", description: "Same description" };
    const updated = { title: "Same title ", description: " Same description" };
    expect(getChangedEditFields(existing, updated)).toEqual([]);
  });
});

describe("getProofLinkChanges (#737)", () => {
  it("lists links added and removed, ignoring order", () => {
    expect(getProofLinkChanges(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], removed: ["a"] });
    expect(getProofLinkChanges(["a", "b"], ["b", "a"])).toEqual({ added: [], removed: [] });
  });
});
