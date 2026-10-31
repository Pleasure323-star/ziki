import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { isLiveHold, liveHold, liveHoldWhere, shownAssignee } from "@/lib/issue-holders";

const now = Date.parse("2026-10-31T12:00:00Z");
const window = 1800;

describe("what holds an issue (#stale-assignee)", () => {
  it("is an active claim, or an offer still inside the project's window", () => {
    expect(isLiveHold({ status: "active" }, window, now)).toBe(true);
    expect(isLiveHold({ status: "offered", offeredAt: new Date(now - 60_000) }, window, now)).toBe(true);
  });

  it("is not an offer past the window, an offer with no time, a released claim or anything else", () => {
    expect(isLiveHold({ status: "offered", offeredAt: new Date(now - window * 1000) }, window, now)).toBe(false);
    expect(isLiveHold({ status: "offered", offeredAt: null }, window, now)).toBe(false);
    expect(isLiveHold({ status: "active", releasedAt: new Date(now) }, window, now)).toBe(false);
    expect(isLiveHold({ status: "released" }, window, now)).toBe(false);
  });

  it("queries the same rule: unreleased, active or offered after the window's start", () => {
    expect(liveHoldWhere(window, now)).toEqual({
      releasedAt: null,
      OR: [
        { status: "active" },
        { status: "offered", offeredAt: { gt: new Date(now - window * 1000) } },
      ],
    });
  });

  it("reads the issue's project window and returns the holding claim or null", async () => {
    const db = {
      projectWorkflow: { findUnique: vi.fn(async () => ({ offerWindowSeconds: 600 })) },
      issueClaim: { findFirst: vi.fn(async () => null) },
    };
    await expect(liveHold({ id: "bug1", projectId: "p-live-hold" }, db as never)).resolves.toBeNull();
    const [args] = db.issueClaim.findFirst.mock.calls[0] as unknown as [{ where: { bugId: string; OR: { offeredAt?: { gt: Date } }[] } }];
    expect(args.where.bugId).toBe("bug1");
    const cutoff = args.where.OR[1].offeredAt!.gt.getTime();
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(600_000);
    expect(Date.now() - cutoff).toBeLessThan(660_000);
  });
});

describe("the assignee the issue page shows", () => {
  const carl = { id: "carl", name: "Carl" };

  it("hides a stale assignee on an Open issue nothing holds", () => {
    expect(shownAssignee("open", carl, false)).toBeNull();
  });

  it("shows the assignee while something holds the issue, or once it has left Open", () => {
    expect(shownAssignee("open", carl, true)).toBe(carl);
    expect(shownAssignee("in_progress", carl, false)).toBe(carl);
    expect(shownAssignee("delivered", carl, false)).toBe(carl);
  });
});
