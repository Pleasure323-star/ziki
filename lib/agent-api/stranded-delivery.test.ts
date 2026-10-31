import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/agent-api/events", () => ({ publish: vi.fn() }));
const workflow = vi.hoisted(() => ({ verdictsNeeded: 2 }));
vi.mock("@/lib/workflow", () => ({ workflowFor: vi.fn(async () => ({ verdictsNeeded: workflow.verdictsNeeded })) }));

import { findStrandedDeliveries, strandedDelivery } from "./stranded-delivery";

const PR = "https://github.com/emerjent/ziki/pull/615";
const NOW = new Date("2026-10-31T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

type Verdict = { owner: string; good?: boolean; onBehalfOf?: string; at?: Date };

function makeDb(opts: {
  status?: string;
  pullRequestUrl?: string | null;
  isDeleted?: boolean;
  assigneeId?: string | null;
  delivered?: boolean;
  linked?: { at: Date; owner: string } | null;
  verdicts?: Verdict[];
  updatedAt?: Date;
}) {
  const bug = {
    id: "bug1",
    tenantId: "t1",
    projectId: "p1",
    status: opts.status ?? "in_progress",
    pullRequestUrl: opts.pullRequestUrl === undefined ? PR : opts.pullRequestUrl,
    isDeleted: opts.isDeleted ?? false,
    updatedAt: opts.updatedAt ?? hoursAgo(48),
    assigneeId: opts.assigneeId === undefined ? "ada" : opts.assigneeId,
    beneficiaryUserId: "rex",
    reporterId: "rex",
    createdByAgentId: null,
    createdByAgent: null,
    claims: [],
  };
  const linked = opts.linked === undefined ? { at: hoursAgo(24), owner: "lin" } : opts.linked;
  return {
    bug: {
      findUnique: vi.fn(async () => bug),
      findMany: vi.fn(async () => [{ id: bug.id, number: 615, title: "Stuck fix" }]),
    },
    delivery: { findFirst: vi.fn(async () => (opts.delivered ? { id: "d1" } : null)) },
    agentAuditEvent: { findFirst: vi.fn(async () => (linked ? { createdAt: linked.at, agent: { ownerUserId: linked.owner } } : null)) },
    testVerdict: {
      findMany: vi.fn(async () =>
        (opts.verdicts ?? [{ owner: "rob" }, { owner: "sam" }]).map((v, i) => ({
          goodToMerge: v.good ?? true,
          headSha: null,
          onBehalfOfUserId: v.onBehalfOf ?? v.owner,
          createdAt: v.at ?? hoursAgo(20),
          agent: { id: `agent-${i}`, ownerUserId: v.owner },
        })),
      ),
    },
    user: { findMany: vi.fn(async () => [{ id: "ada", name: "Ada" }]) },
  };
}

describe("strandedDelivery (#stranded-delivery)", () => {
  beforeEach(() => {
    workflow.verdictsNeeded = 2;
  });

  it("qualifies an In progress issue with a pull request linked long ago, no delivery and enough good judgements", async () => {
    const result = await strandedDelivery("bug1", makeDb({}) as never, NOW);
    expect(result).toEqual({ pullRequestUrl: PR, creditedUserId: "ada", linkedAt: hoursAgo(24), goodVerdicts: 2, needed: 2 });
  });

  it("does not qualify a pull request linked two hours ago or less", async () => {
    expect(await strandedDelivery("bug1", makeDb({ linked: { at: hoursAgo(1), owner: "lin" } }) as never, NOW)).toBeNull();
    expect(await strandedDelivery("bug1", makeDb({ linked: { at: hoursAgo(2), owner: "lin" } }) as never, NOW)).toBeNull();
  });

  it("dates the link from the earliest judgement when no link was recorded, else the issue's last update", async () => {
    const recent = makeDb({ linked: null, verdicts: [{ owner: "rob", at: hoursAgo(1) }, { owner: "sam", at: hoursAgo(0.5) }] });
    expect(await strandedDelivery("bug1", recent as never, NOW)).toBeNull();
    const old = makeDb({ linked: null, verdicts: [{ owner: "rob", at: hoursAgo(5) }, { owner: "sam", at: hoursAgo(1) }] });
    expect((await strandedDelivery("bug1", old as never, NOW))?.linkedAt).toEqual(hoursAgo(5));
  });

  it("does not qualify an issue that already has a delivery", async () => {
    expect(await strandedDelivery("bug1", makeDb({ delivered: true }) as never, NOW)).toBeNull();
  });

  it("does not qualify an issue that isn't In progress, has no pull request, or is deleted", async () => {
    expect(await strandedDelivery("bug1", makeDb({ status: "delivered" }) as never, NOW)).toBeNull();
    expect(await strandedDelivery("bug1", makeDb({ pullRequestUrl: null }) as never, NOW)).toBeNull();
    expect(await strandedDelivery("bug1", makeDb({ isDeleted: true }) as never, NOW)).toBeNull();
  });

  it("follows the project's required number of judgements", async () => {
    workflow.verdictsNeeded = 3;
    expect(await strandedDelivery("bug1", makeDb({}) as never, NOW)).toBeNull();
    workflow.verdictsNeeded = 1;
    expect(await strandedDelivery("bug1", makeDb({}) as never, NOW)).toMatchObject({ goodVerdicts: 2, needed: 1 });
  });

  it("counts only independent good judgements: one per owner, none from or for the credited person", async () => {
    const sameOwner = makeDb({ verdicts: [{ owner: "rob" }, { owner: "rob" }, { owner: "sam", good: false }] });
    expect(await strandedDelivery("bug1", sameOwner as never, NOW)).toBeNull();
    // Credited through the agent that linked it: that owner's judgement, or one on their behalf, doesn't count.
    const byLinker = makeDb({ assigneeId: null, verdicts: [{ owner: "lin" }, { owner: "rob", onBehalfOf: "lin" }, { owner: "sam" }] });
    expect(await strandedDelivery("bug1", byLinker as never, NOW)).toBeNull();
  });

  it("credits the assignee, else the owner of the agent that linked it, and needs someone to credit", async () => {
    expect(await strandedDelivery("bug1", makeDb({ assigneeId: null }) as never, NOW)).toMatchObject({ creditedUserId: "lin" });
    expect(await strandedDelivery("bug1", makeDb({ assigneeId: null, linked: null }) as never, NOW)).toBeNull();
  });

  it("lists a project's stranded deliveries with the credited person's name", async () => {
    const found = await findStrandedDeliveries("t1", "p1", makeDb({}) as never, NOW);
    expect(found).toEqual([expect.objectContaining({ id: "bug1", number: 615, creditedUserId: "ada", creditedName: "Ada", goodVerdicts: 2 })]);
  });
});
