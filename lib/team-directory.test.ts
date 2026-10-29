import { describe, expect, it, vi } from "vitest";
import {
  TEAM_ONLINE_WINDOW_MS,
  isTeamAgentOnline,
  teamAgentsForMembers,
  teamAssignedWorkForMember,
  teamAssignedWorkForMembers,
  teamMetricSince,
  type TeamAgent,
} from "./team-directory";

describe("team directory metrics", () => {
  const now = new Date("2026-10-20T12:00:00Z");

  it("uses the 15-minute heartbeat window and a rolling 30-day metric period", () => {
    expect(isTeamAgentOnline(new Date(now.getTime() - TEAM_ONLINE_WINDOW_MS + 1), now)).toBe(true);
    expect(isTeamAgentOnline(new Date(now.getTime() - TEAM_ONLINE_WINDOW_MS), now)).toBe(false);
    expect(isTeamAgentOnline(null, now)).toBe(false);
    expect(teamMetricSince(now)).toEqual(new Date("2026-09-20T12:00:00Z"));
  });

  it("loads only active agents and tenant-scoped work and counts accepted fixes once per issue", async () => {
    const agentFindMany = vi.fn().mockResolvedValue([
      {
        id: "agent-1",
        ownerUserId: "person-1",
        name: "Ada's agent",
        model: "Claude",
        level: "working",
        apiKeys: [{ lastUsedAt: null }],
        claims: [
          {
            claimedAt: new Date(now.getTime() - 5 * 60 * 1000),
            lastHeartbeatAt: null,
            bug: { id: "issue-current", title: "Current work", categoryId: "area-1", category: { name: "Web" }, areaId: "pa-checkout", area: { name: "Checkout" } },
          },
        ],
      },
      {
        id: "agent-2",
        ownerUserId: "person-1",
        name: "Ada's second agent",
        model: null,
        level: "working",
        apiKeys: [],
        claims: [],
      },
    ]);
    const fixedClaimFindMany = vi.fn().mockResolvedValue([
      { agentId: "agent-1", bugId: "issue-fixed" },
      { agentId: "agent-1", bugId: "issue-fixed" },
    ]);
    const db = {
      agent: { findMany: agentFindMany },
      issueClaim: { findMany: fixedClaimFindMany },
    };

    const result = await teamAgentsForMembers(db as never, "tenant-1", ["person-1"], now);

    expect(agentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", ownerUserId: { in: ["person-1"] }, revokedAt: null },
      select: expect.objectContaining({
        apiKeys: { where: { revokedAt: null }, select: { lastUsedAt: true } },
        claims: expect.objectContaining({
          where: expect.objectContaining({
            status: "active",
            releasedAt: null,
            bug: { tenantId: "tenant-1", isDeleted: false, status: "in_progress" },
          }),
        }),
      }),
    }));
    expect(fixedClaimFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        agentId: { in: ["agent-1", "agent-2"] },
        status: "released",
        releasedAt: { not: null },
        releaseReason: "resolved",
        bug: expect.objectContaining({
          tenantId: "tenant-1",
          pointEntries: {
            some: expect.objectContaining({
              tenantId: "tenant-1",
              role: "solver",
              points: { gt: 0 },
              correctedAt: null,
              createdAt: { gte: teamMetricSince(now) },
            }),
          },
        }),
      }),
    }));
    expect(result.get("person-1")).toEqual([
      {
        id: "agent-1",
        name: "Ada's agent",
        model: "Claude",
        level: "working",
        online: true,
        acceptedFixes: 1,
        currentWork: [{ id: "issue-current", title: "Current work", categoryId: "area-1", categoryName: "Web", areaId: "pa-checkout", areaName: "Checkout" }],
      },
      {
        id: "agent-2",
        name: "Ada's second agent",
        model: null,
        level: "working",
        online: false,
        acceptedFixes: 0,
        currentWork: [],
      },
    ]);
  });

  it("counts recent API use as online, without a claim (#1123)", async () => {
    const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60 * 1000);
    const agent = (id: string, apiKeys: { lastUsedAt: Date | null }[], claims: unknown[] = []) => ({
      id, ownerUserId: "person-1", name: id, model: null, level: "working", apiKeys, claims,
    });
    const db = {
      agent: {
        findMany: vi.fn().mockResolvedValue([
          // Polling and reviewing, no claim: the case #1123 reported.
          agent("polling", [{ lastUsedAt: minutesAgo(1) }]),
          // Idle for longer than the window.
          agent("idle", [{ lastUsedAt: minutesAgo(20) }]),
          // An old key, but a fresh claim heartbeat still counts.
          agent("heartbeat", [{ lastUsedAt: minutesAgo(60) }], [
            { claimedAt: minutesAgo(90), lastHeartbeatAt: minutesAgo(2), bug: { id: "i1", title: "Work", categoryId: null, category: null } },
          ]),
          // Never used, nothing claimed.
          agent("unused", [{ lastUsedAt: null }]),
        ]),
      },
      issueClaim: { findMany: vi.fn().mockResolvedValue([]) },
    };

    const result = await teamAgentsForMembers(db as never, "tenant-1", ["person-1"], now);

    expect(Object.fromEntries((result.get("person-1") ?? []).map((a) => [a.id, a.online]))).toEqual({
      polling: true,
      idle: false,
      heartbeat: true,
      unused: false,
    });
  });

  it("does not query claims when a member has no active agents", async () => {
    const issueClaimFindMany = vi.fn();
    const db = {
      agent: { findMany: vi.fn().mockResolvedValue([]) },
      issueClaim: { findMany: issueClaimFindMany },
    };

    await expect(teamAgentsForMembers(db as never, "tenant-1", ["person-1"], now)).resolves.toEqual(
      new Map([["person-1", []]]),
    );
    expect(issueClaimFindMany).not.toHaveBeenCalled();
  });

  it("skips database reads when there are no member ids", async () => {
    const agentFindMany = vi.fn();
    const db = { agent: { findMany: agentFindMany }, issueClaim: { findMany: vi.fn() } };

    await expect(teamAgentsForMembers(db as never, "tenant-1", [], now)).resolves.toEqual(new Map());
    expect(agentFindMany).not.toHaveBeenCalled();
  });
});

describe("assigned work no agent has claimed (Ziki #447)", () => {
  const work = (id: string) => ({ id, title: id, categoryId: null, categoryName: null, areaId: null, areaName: null });
  const agent = (id: string, currentWork: string[]): TeamAgent => ({
    id, name: id, model: null, level: "working", online: false, acceptedFixes: 0, currentWork: currentWork.map(work),
  });
  const bug = (id: string, assigneeId: string | null) => ({
    id, title: id, assigneeId, categoryId: "cat", category: { name: "Web" }, areaId: "area", area: { name: "Checkout" },
  });

  it("reads open and in-progress, non-deleted issues assigned to the members, in this tenant", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await teamAssignedWorkForMembers({ bug: { findMany } } as never, "tenant-1", new Map([["p1", []], ["p2", []]]));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", isDeleted: false, status: { in: ["requires_confirmation", "open", "in_progress"] }, assigneeId: { in: ["p1", "p2"] } },
    }));
  });

  it("lists an assignee-only issue for the member, with its category and area", async () => {
    const db = { bug: { findMany: vi.fn().mockResolvedValue([bug("issue-a", "p1")]) } };
    const result = await teamAssignedWorkForMembers(db as never, "tenant-1", new Map([["p1", [agent("agent-1", [])]]]));
    expect(result.get("p1")).toEqual([{ id: "issue-a", title: "issue-a", categoryId: "cat", categoryName: "Web", areaId: "area", areaName: "Checkout" }]);
  });

  it("leaves out an issue already on one of the member's agent cards, so it counts once", async () => {
    const db = { bug: { findMany: vi.fn().mockResolvedValue([bug("claimed", "p1"), bug("manual", "p1")]) } };
    const agents = new Map([["p1", [agent("agent-1", []), agent("agent-2", ["claimed"])]]]);
    const result = await teamAssignedWorkForMembers(db as never, "tenant-1", agents);
    expect(result.get("p1")?.map((w) => w.id)).toEqual(["manual"]);
  });

  it("keeps several assigned issues, once each, for a member with several agents", async () => {
    const db = { bug: { findMany: vi.fn().mockResolvedValue([bug("one", "p1"), bug("two", "p1"), bug("other", "p2")]) } };
    const agents = new Map([["p1", [agent("agent-1", []), agent("agent-2", [])]], ["p2", []]]);
    const result = await teamAssignedWorkForMembers(db as never, "tenant-1", agents);
    expect(result.get("p1")?.map((w) => w.id)).toEqual(["one", "two"]);
    expect(result.get("p2")?.map((w) => w.id)).toEqual(["other"]);
  });

  it("still lists an issue whose only claim is held by a revoked agent", async () => {
    // Revoked agents aren't loaded, so their claim is on no card here.
    const db = { bug: { findMany: vi.fn().mockResolvedValue([bug("revoked-claim", "p1")]) } };
    const result = await teamAssignedWorkForMember(db as never, "tenant-1", "p1", []);
    expect(result.map((w) => w.id)).toEqual(["revoked-claim"]);
  });

  it("skips the read when there are no members", async () => {
    const findMany = vi.fn();
    expect(await teamAssignedWorkForMembers({ bug: { findMany } } as never, "tenant-1", new Map())).toEqual(new Map());
    expect(findMany).not.toHaveBeenCalled();
  });
});
