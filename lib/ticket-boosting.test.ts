import { describe, expect, it } from "vitest";
import {
  canBoostTicket,
  shouldUnboostOnStatusChange,
} from "./ticket-boosting";

describe("canBoostTicket", () => {
  it("allows an owner or admin of the organization to boost tickets", () => {
    expect(canBoostTicket("user", "owner")).toBe(true);
    expect(canBoostTicket("user", "admin")).toBe(true);
  });

  it("allows super admins to boost tickets", () => {
    expect(canBoostTicket("super_admin")).toBe(true);
  });

  it("denies a site-wide admin who is only a member", () => {
    expect(canBoostTicket("admin", "member")).toBe(false);
  });

  it("denies regular users from boosting tickets", () => {
    expect(canBoostTicket("user")).toBe(false);
  });

  it("denies unauthenticated or missing roles", () => {
    expect(canBoostTicket(null)).toBe(false);
    expect(canBoostTicket(undefined)).toBe(false);
  });
});

describe("shouldUnboostOnStatusChange (#256)", () => {
  it.each(["resolved", "closed"])("unboosts a boosted issue moved to %s", (to) => {
    expect(shouldUnboostOnStatusChange({ isBoosted: true, from: "open", to })).toBe(true);
  });

  it.each(["open", "in_progress"])("keeps the boost when moved to %s", (to) => {
    expect(shouldUnboostOnStatusChange({ isBoosted: true, from: "resolved", to })).toBe(false);
  });

  it("does nothing for issues that aren't boosted", () => {
    expect(shouldUnboostOnStatusChange({ isBoosted: false, from: "open", to: "closed" })).toBe(false);
  });

  it("does nothing when the status isn't changing", () => {
    expect(shouldUnboostOnStatusChange({ isBoosted: true, from: "closed", to: "closed" })).toBe(false);
    expect(shouldUnboostOnStatusChange({ isBoosted: true, from: "open", to: undefined })).toBe(false);
  });
});
