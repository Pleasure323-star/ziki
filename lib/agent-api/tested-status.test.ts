import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshTestedStatus, TESTED } from "./tested-status";

const PR = "https://github.com/emerjent/ziki/pull/9";

function makeDb(opts: {
  reviewStatus?: string | null;
  pullRequestUrl?: string | null;
  verdicts?: { owner: string; agent?: string; onBehalfOf?: string }[];
  claimOwner?: string;
}) {
  const bug = {
    id: "bug1",
    projectId: "p1",
    reviewStatus: opts.reviewStatus === undefined ? "submitted" : opts.reviewStatus,
    pullRequestUrl: opts.pullRequestUrl === undefined ? PR : opts.pullRequestUrl,
    assigneeId: "ada",
    beneficiaryUserId: "ada",
    reporterId: "rex",
    createdByAgentId: null,
    createdByAgent: null,
    claims: [
      { status: "active", releasedAt: null, agentId: "solver", beneficiaryUserId: "ada", dispatcherUserId: null, agent: { ownerUserId: opts.claimOwner ?? "ada" } },
    ],
  };
  return {
    bug: { findUnique: vi.fn(async () => bug), update: vi.fn(async () => ({})) },
    testVerdict: {
      findMany: vi.fn(async () =>
        (opts.verdicts ?? []).map((v, i) => ({
          onBehalfOfUserId: v.onBehalfOf ?? v.owner,
          agent: { id: v.agent ?? `agent-${i}`, ownerUserId: v.owner },
        })),
      ),
    },
    bugActivity: { create: vi.fn(async () => ({})) },
  };
}

describe("refreshTestedStatus: the Done step (Ziki #713)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("moves a submitted fix to tested once two independent reviewers say good to merge", async () => {
    const db = makeDb({ verdicts: [{ owner: "rob" }, { owner: "sam" }] });
    expect(await refreshTestedStatus(db as never, "bug1", "sam")).toBe(TESTED);
    expect(db.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { reviewStatus: TESTED } });
    expect(db.bugActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ summary: expect.stringContaining("moved to Done") }) }),
    );
  });

  it("keeps it in progress with only one reviewer", async () => {
    const db = makeDb({ verdicts: [{ owner: "rob" }] });
    expect(await refreshTestedStatus(db as never, "bug1", "rob")).toBeNull();
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("counts two agents of one owner once", async () => {
    const db = makeDb({ verdicts: [{ owner: "rob", agent: "a1" }, { owner: "rob", agent: "a2" }] });
    expect(await refreshTestedStatus(db as never, "bug1", "rob")).toBeNull();
  });

  it("doesn't count a verdict from the fixer's own side", async () => {
    const db = makeDb({ verdicts: [{ owner: "rob" }, { owner: "ada" }] });
    expect(await refreshTestedStatus(db as never, "bug1", "rob")).toBeNull();
  });

  it("moves a tested fix back to in progress when a reviewer takes their verdict back", async () => {
    const db = makeDb({ reviewStatus: TESTED, verdicts: [{ owner: "rob" }] });
    expect(await refreshTestedStatus(db as never, "bug1", "sam")).toBe("submitted");
    expect(db.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { reviewStatus: "submitted" } });
  });

  it("leaves later steps alone: ready to merge, merged, rejected", async () => {
    for (const reviewStatus of ["ready_to_merge", "merged", "rejected", "merge_blocked"]) {
      const db = makeDb({ reviewStatus, verdicts: [{ owner: "rob" }, { owner: "sam" }] });
      expect(await refreshTestedStatus(db as never, "bug1", "sam")).toBeNull();
      expect(db.bug.update).not.toHaveBeenCalled();
    }
  });

  it("does nothing without a linked pull request", async () => {
    const db = makeDb({ pullRequestUrl: null, verdicts: [{ owner: "rob" }, { owner: "sam" }] });
    expect(await refreshTestedStatus(db as never, "bug1", "sam")).toBeNull();
  });
});
