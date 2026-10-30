import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock("@/lib/agent-api/events", () => ({ publish: events.publish }));

import { refreshJudgedStatus } from "./tested-status";

const PR = "https://github.com/emerjent/ziki/pull/9";

function makeDb(opts: {
  status?: string;
  pullRequestUrl?: string | null;
  verdicts?: { owner: string; good?: boolean; agent?: string; onBehalfOf?: string }[];
  claimOwner?: string;
}) {
  const bug = {
    id: "bug1",
    tenantId: "t1",
    projectId: "p1",
    status: opts.status ?? "delivered",
    pullRequestUrl: opts.pullRequestUrl === undefined ? PR : opts.pullRequestUrl,
    assigneeId: "ada",
    beneficiaryUserId: "ada",
    reporterId: "rex",
    createdByAgentId: null,
    createdByAgent: null,
    claims: [
      { id: "claim1", status: "active", claimedAt: new Date(), releasedAt: null, agentId: "solver", beneficiaryUserId: "ada", dispatcherUserId: null, agent: { ownerUserId: opts.claimOwner ?? "ada" } },
    ],
  };
  return {
    bug: { findUnique: vi.fn(async () => bug), update: vi.fn(async () => ({})) },
    testVerdict: {
      findMany: vi.fn(async () =>
        (opts.verdicts ?? []).map((v, i) => ({
          goodToMerge: v.good ?? true,
          headSha: null,
          onBehalfOfUserId: v.onBehalfOf ?? v.owner,
          agent: { id: v.agent ?? `agent-${i}`, ownerUserId: v.owner },
        })),
      ),
    },
    issueClaim: { update: vi.fn(async () => ({})) },
    bugActivity: { create: vi.fn(async () => ({})) },
  };
}

describe("refreshJudgedStatus: the Delivered step (#delivered-step)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("moves delivered work to Done once two independent agents judge it good to merge", async () => {
    const db = makeDb({ verdicts: [{ owner: "rob" }, { owner: "sam" }] });
    expect(await refreshJudgedStatus(db as never, "bug1", "sam")).toBe("done");
    expect(db.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { status: "done" } });
    expect(db.bugActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ summary: expect.stringContaining("moved to Done") }) }),
    );
  });

  it("sends it back to Open, releasing the claim and clearing the pull request, once two judge it not good", async () => {
    const db = makeDb({ verdicts: [{ owner: "rob", good: false }, { owner: "sam", good: false }] });
    expect(await refreshJudgedStatus(db as never, "bug1", "sam")).toBe("open");
    expect(db.issueClaim.update).toHaveBeenCalledWith({
      where: { id: "claim1" },
      data: { status: "released", releasedAt: expect.any(Date), releaseReason: "judged_not_good" },
    });
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "bug1" },
      data: { status: "open", assigneeId: null, pullRequestUrl: null, pullRequestHeadSha: null },
    });
    expect(events.publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "claim.released" }));
  });

  it("stays Delivered with one judgement of each kind", async () => {
    const db = makeDb({ verdicts: [{ owner: "rob" }, { owner: "sam", good: false }] });
    expect(await refreshJudgedStatus(db as never, "bug1", "rob")).toBeNull();
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("counts two agents of one owner once, and none from the delivering side", async () => {
    expect(await refreshJudgedStatus(makeDb({ verdicts: [{ owner: "rob", agent: "a1" }, { owner: "rob", agent: "a2" }] }) as never, "bug1", "rob")).toBeNull();
    expect(await refreshJudgedStatus(makeDb({ verdicts: [{ owner: "rob" }, { owner: "ada" }] }) as never, "bug1", "rob")).toBeNull();
  });

  it("returns Done to Delivered when a judgement changes and the good count drops", async () => {
    const db = makeDb({ status: "done", verdicts: [{ owner: "rob" }] });
    expect(await refreshJudgedStatus(db as never, "bug1", "sam")).toBe("delivered");
    expect(db.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { status: "delivered" } });
  });

  it("leaves every other status alone", async () => {
    for (const status of ["in_progress", "ready_to_merge", "resolved", "closed", "open"]) {
      const db = makeDb({ status, verdicts: [{ owner: "rob" }, { owner: "sam" }] });
      expect(await refreshJudgedStatus(db as never, "bug1", "sam")).toBeNull();
      expect(db.bug.update).not.toHaveBeenCalled();
    }
  });

  it("does nothing without a delivered pull request", async () => {
    const db = makeDb({ pullRequestUrl: null, verdicts: [{ owner: "rob" }, { owner: "sam" }] });
    expect(await refreshJudgedStatus(db as never, "bug1", "sam")).toBeNull();
  });
});
