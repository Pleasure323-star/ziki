import { describe, expect, it } from "vitest";
import {
  AGENT_IDLE_WINDOW_MS,
  PREVIEW_LIMIT,
  RESOLVED_STATUSES,
  UNRESOLVED_STATUSES,
  classifyAgentStatus,
  firstCloseForTenant,
  isResolvedStatus,
  isUnresolvedStatus,
} from "./dashboard-overview";
import { isDone } from "./issue-state";

const ALL_STATUSES = ["requires_confirmation", "open", "in_progress", "resolved", "closed"] as const;

describe("dashboard overview counts (#dashboard)", () => {
  it("shows exactly three preview rows per card", () => {
    expect(PREVIEW_LIMIT).toBe(3);
  });

  it("partitions every issue into unresolved or resolved, never both", () => {
    for (const status of ALL_STATUSES) {
      const unresolved = isUnresolvedStatus(status);
      const resolved = isResolvedStatus(status);
      expect(unresolved || resolved).toBe(true);
      expect(unresolved && resolved).toBe(false);
    }
  });

  it("matches the app's finished convention (isDone)", () => {
    for (const status of ALL_STATUSES) {
      expect(isResolvedStatus(status)).toBe(isDone(status));
    }
  });

  it("scopes the first-close aggregate to one workspace", () => {
    const sql = firstCloseForTenant("tenant-acme");
    const text = sql.strings.join(" ");
    expect(text).toContain('bug."tenantId"');
    expect(text).toContain('bug."isDeleted"');
    expect(text).not.toMatch(/FROM "BugActivity" a\s+WHERE/);
    expect(sql.values).toContain("tenant-acme");
  });

  it("counts requires confirmation, open and in progress as unresolved and resolved + closed as resolved", () => {
    expect([...UNRESOLVED_STATUSES]).toEqual(["requires_confirmation", "open", "in_progress"]);
    expect([...RESOLVED_STATUSES]).toEqual(["resolved", "closed"]);
    // Together they cover the whole Status enum — no issue is left uncounted.
    expect(new Set([...UNRESOLVED_STATUSES, ...RESOLVED_STATUSES])).toEqual(
      new Set(ALL_STATUSES),
    );
  });

  it("rejects non-status strings", () => {
    expect(isUnresolvedStatus("deleted")).toBe(false);
    expect(isResolvedStatus("deleted")).toBe(false);
    expect(isUnresolvedStatus("")).toBe(false);
    expect(isResolvedStatus("")).toBe(false);
  });
});

describe("classifyAgentStatus (#dashboard)", () => {
  const now = new Date("2026-05-01T12:00:00Z");
  const minutesAgo = (minutes: number) =>
    new Date(now.getTime() - minutes * 60 * 1000);

  it("an unanswered question outranks everything: Waiting on you", () => {
    expect(
      classifyAgentStatus({
        hasUnansweredQuestion: true,
        hasActiveClaim: true,
        lastSeenAt: minutesAgo(1),
        now,
      }),
    ).toBe("waiting");
  });

  it("a live claim is Working", () => {
    expect(
      classifyAgentStatus({
        hasUnansweredQuestion: false,
        hasActiveClaim: true,
        lastSeenAt: null,
        now,
      }),
    ).toBe("working");
  });

  it("recent activity without work is Idle", () => {
    expect(
      classifyAgentStatus({
        hasUnansweredQuestion: false,
        hasActiveClaim: false,
        lastSeenAt: minutesAgo(60),
        now,
      }),
    ).toBe("idle");
  });

  it("no recent signal at all is Offline", () => {
    expect(
      classifyAgentStatus({
        hasUnansweredQuestion: false,
        hasActiveClaim: false,
        lastSeenAt: minutesAgo(60 * 24 * 2),
        now,
      }),
    ).toBe("offline");
    expect(
      classifyAgentStatus({
        hasUnansweredQuestion: false,
        hasActiveClaim: false,
        lastSeenAt: null,
        now,
      }),
    ).toBe("offline");
  });

  it("treats exactly the idle window as still seen", () => {
    expect(
      classifyAgentStatus({
        hasUnansweredQuestion: false,
        hasActiveClaim: false,
        lastSeenAt: new Date(now.getTime() - AGENT_IDLE_WINDOW_MS),
        now,
      }),
    ).toBe("idle");
    expect(
      classifyAgentStatus({
        hasUnansweredQuestion: false,
        hasActiveClaim: false,
        lastSeenAt: new Date(now.getTime() - AGENT_IDLE_WINDOW_MS - 1),
        now,
      }),
    ).toBe("offline");
  });
});
