import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/workflow", async () => {
  const { DEFAULT_PROJECT_WORKFLOW } = await import("@/lib/workflow-config");
  return { workflowFor: vi.fn(async () => ({ ...DEFAULT_PROJECT_WORKFLOW })) };
});

import { DEFAULT_PROJECT_WORKFLOW } from "@/lib/workflow-config";
import { findIdleInProgress, idleInProgress, isIdle, lastUpdateAt } from "./idle";

const NOW = new Date("2026-10-31T12:00:00Z").getTime();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000);
const LONG_AGO = ago(24 * 60);

type Sources = {
  status?: string;
  updatedAt?: Date;
  claim?: { claimedAt?: Date | null; extendedAt?: Date | null; lastHeartbeatAt?: Date | null } | null;
  comment?: Date;
  delivery?: Date;
  activity?: Date;
  linked?: Date;
};

/** A database double for one issue; every "last update" source is long ago unless given. */
function makeDb(sources: Sources = {}) {
  const bug = { id: "b1", projectId: "p1", updatedAt: sources.updatedAt ?? LONG_AGO, number: 7, title: "Stuck", pullRequestUrl: null };
  const inProgress = (sources.status ?? "in_progress") === "in_progress";
  const claim = sources.claim === null || sources.claim === undefined
    ? null
    : {
      id: "c1",
      agentId: "a1",
      beneficiaryUserId: "ada",
      claimedAt: sources.claim.claimedAt ?? LONG_AGO,
      extendedAt: sources.claim.extendedAt ?? null,
      lastHeartbeatAt: sources.claim.lastHeartbeatAt ?? null,
      agent: { ownerUserId: "ada" },
    };
  return {
    bug: {
      findFirst: vi.fn(async () => (inProgress ? bug : null)),
      findMany: vi.fn(async () => (inProgress ? [bug] : [])),
    },
    issueClaim: { findFirst: vi.fn(async () => claim) },
    comment: { findFirst: vi.fn(async () => (sources.comment ? { createdAt: sources.comment } : null)) },
    delivery: { findFirst: vi.fn(async () => (sources.delivery ? { updatedAt: sources.delivery } : null)) },
    bugActivity: { findFirst: vi.fn(async () => (sources.activity ? { createdAt: sources.activity } : null)) },
    agentAuditEvent: { findFirst: vi.fn(async () => (sources.linked ? { createdAt: sources.linked } : null)) },
  };
}

const idle = (sources: Sources) => idleInProgress("b1", makeDb(sources) as never, NOW);

describe("idle In progress work (#idle)", () => {
  it("uses a two-hour window by default", () => {
    expect(DEFAULT_PROJECT_WORKFLOW.abandonCheckMinutes).toBe(120);
  });

  it("takes the latest real update, ignoring missing dates", () => {
    const claimed = new Date("2026-10-30T08:00:00Z");
    const commented = new Date("2026-10-30T11:00:00Z");
    const changed = new Date("2026-10-30T09:30:00Z");
    expect(lastUpdateAt([claimed, null, commented, undefined, changed])).toEqual(commented);
    expect(lastUpdateAt([null, undefined])).toBeNull();
    expect(lastUpdateAt([])).toBeNull();
  });

  it("is idle once the window has passed with no update, not before", () => {
    const last = new Date("2026-10-30T06:00:00Z");
    const twoHours = 120 * 60_000;
    expect(isIdle(last, 120, last.getTime() + twoHours - 1)).toBe(false);
    expect(isIdle(last, 120, last.getTime() + twoHours)).toBe(true);
    expect(isIdle(last, 0, last.getTime())).toBe(true);
    // Nothing to measure from: never idle.
    expect(isIdle(null, 0, last.getTime())).toBe(false);
  });

  it("finds an In progress issue idle at two hours, held or not, and not a minute before", async () => {
    await expect(idle({ updatedAt: ago(120) })).resolves.toMatchObject({ claim: null, lastUpdate: ago(120), windowMinutes: 120 });
    await expect(idle({ updatedAt: ago(119) })).resolves.toBeNull();
    await expect(idle({ claim: {} })).resolves.toMatchObject({ claim: { id: "c1" } });
  });

  it("is never idle when the issue is not In progress", async () => {
    await expect(idle({ status: "open" })).resolves.toBeNull();
  });

  it.each([
    ["the claim being taken", { claim: { claimedAt: ago(30) } }],
    ["the claim being extended", { claim: { extendedAt: ago(30) } }],
    ["the issue changing", { updatedAt: ago(30) }],
    ["a comment", { comment: ago(30) }],
    ["a delivery", { delivery: ago(30) }],
    ["an activity-log entry", { activity: ago(30) }],
    ["the pull request being linked", { linked: ago(30) }],
  ] as [string, Sources][])("resets the clock on %s", async (_source, sources) => {
    await expect(idle(sources)).resolves.toBeNull();
  });

  it("does not count a heartbeat as an update", async () => {
    await expect(idle({ claim: { lastHeartbeatAt: ago(1) } })).resolves.toMatchObject({ claim: { id: "c1" } });
  });

  it("lists a project's idle issues with their number and title", async () => {
    const found = await findIdleInProgress("t1", "p1", makeDb({}) as never, NOW);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ number: 7, title: "Stuck", pullRequestUrl: null, claim: null, bug: { id: "b1" } });
    await expect(findIdleInProgress("t1", "p1", makeDb({ updatedAt: ago(5) }) as never, NOW)).resolves.toEqual([]);
  });
});
