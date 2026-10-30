import { describe, expect, it } from "vitest";
import { formatDate, formatTimeAgo } from "./format";

describe("formatDate", () => {
  it("formats dates with custom timezone", () => {
    // 18:30 UTC is 19:30 in Africa/Lagos (UTC+1)
    const utcDate = new Date("2026-10-15T18:30:00Z");
    const formattedLagos = formatDate(utcDate, "Africa/Lagos");
    expect(formattedLagos).toBe("Oct 15, 2026, 7:30 PM");

    // 18:30 UTC is 18:30 in UTC
    const formattedUtc = formatDate(utcDate, "UTC");
    expect(formattedUtc).toBe("Oct 15, 2026, 6:30 PM");

    // 18:30 UTC is 14:30 in America/New_York (EDT, UTC-4)
    const formattedNy = formatDate(utcDate, "America/New_York");
    expect(formattedNy).toBe("Oct 15, 2026, 2:30 PM");
  });

  it("handles string date inputs", () => {
    const formatted = formatDate("2026-10-15T18:30:00Z", "Africa/Lagos");
    expect(formatted).toBe("Oct 15, 2026, 7:30 PM");
  });
});

describe("formatTimeAgo: the one humanized time", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  it.each([
    ["2026-10-21T11:59:30Z", "just now"],
    ["2026-10-21T11:59:00Z", "1 min ago"],
    ["2026-10-21T11:30:00Z", "30 mins ago"],
    ["2026-10-21T11:00:00Z", "1 hour ago"],
    ["2026-10-21T09:00:00Z", "3 hours ago"],
    ["2026-10-20T12:00:00Z", "yesterday"],
    ["2026-10-19T12:00:00Z", "2 days ago"],
    ["2026-10-14T13:00:00Z", "6 days ago"],
    ["2026-10-14T12:00:00Z", "1 week ago"],
    ["2026-09-30T12:00:00Z", "3 weeks ago"],
    ["2026-09-12T12:00:00Z", "Sep 12"],
    ["2025-12-30T12:00:00Z", "Dec 30, 2025"],
  ])("%s → %s", (when, expected) => {
    expect(formatTimeAgo(new Date(when), now, "UTC")).toBe(expected);
  });

  it.each([
    ["2026-10-21T12:00:30Z", "just now"],
    ["2026-10-21T12:30:00Z", "in 30 mins"],
    ["2026-10-21T15:00:00Z", "in 3 hours"],
    ["2026-10-22T12:00:00Z", "tomorrow"],
    ["2026-10-24T12:00:00Z", "in 3 days"],
    ["2026-11-04T12:00:00Z", "in 2 weeks"],
  ])("a future %s reads ahead: %s", (when, expected) => {
    expect(formatTimeAgo(new Date(when), now, "UTC")).toBe(expected);
  });

  it("takes a string date", () => {
    expect(formatTimeAgo("2026-10-21T09:00:00Z", now, "UTC")).toBe("3 hours ago");
  });
});
