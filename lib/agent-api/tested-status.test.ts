import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshTestedStatus } from "./tested-status";

const PR = "https://github.com/emerjent/ziki/pull/9";

function makeDb(opts: {
  status?: string;
  pullRequestUrl?: string | null;
  verdicts?: { owner: string; agent?: string; onBehalfOf?: string }[];
  claimOwner?: string;
}) {
  const bug = {
    id: "bug1",
    projectId: "p1",
    status: opts.status ?? "in_progress",
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

  it("moves a fix in progress to Done once two independent reviewers say good to merge", async () => {
    const db = makeDb({ verdicts: [{ owner: "rob" }, { owner: "sam" }] });
    expect(await refreshTestedStatus(db as never, "bug1", "sam")).toBe("done");
    expect(db.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { status: "done" } });
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

  it("moves a Done fix back to In progress when a reviewer takes their verdict back", async () => {
    const db = makeDb({ status: "done", verdicts: [{ owner: "rob" }] });
    expect(await refreshTestedStatus(db as never, "bug1", "sam")).toBe("in_progress");
    expect(db.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { status: "in_progress" } });
  });

  it("leaves every other status alone: Ready to merge, Live, Closed, Open", async () => {
    for (const status of ["ready_to_merge", "resolved", "closed", "open"]) {
      const db = makeDb({ status, verdicts: [{ owner: "rob" }, { owner: "sam" }] });
      expect(await refreshTestedStatus(db as never, "bug1", "sam")).toBeNull();
      expect(db.bug.update).not.toHaveBeenCalled();
    }
  });

  it("does nothing without a linked pull request", async () => {
    const db = makeDb({ pullRequestUrl: null, verdicts: [{ owner: "rob" }, { owner: "sam" }] });
    expect(await refreshTestedStatus(db as never, "bug1", "sam")).toBeNull();
  });
});
