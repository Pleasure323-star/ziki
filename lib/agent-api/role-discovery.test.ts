import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  bug: { findMany: vi.fn() },
  issueValidation: { findMany: vi.fn() },
  workflow: { findFirst: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/workflow", () => ({
  workflowFor: vi.fn(async () => ({
    confirmationsNeeded: 2,
    verdictsNeeded: 2,
    offerWindowSeconds: 1800,
  })),
}));
vi.mock("@/lib/agent-api/validation", () => ({
  isConfirmed: vi.fn(async () => true),
}));
// The merge queue reads confirmation in one bulk call (#714); these are confirmed.
vi.mock("@/lib/issue-stage", async (original) => ({
  ...(await original<typeof import("@/lib/issue-stage")>()),
  confirmedIssueIds: vi.fn(async () => new Set(["bug-1", "bug-accepted", "bug-blocked", "bug-self"])),
}));

import { findReadyToMergeIssues } from "./merger";
import { findReviewableIssues } from "./reviewer";
import { findClaimableIssues } from "./contributor";
import { AgentLevelError } from "@/lib/agents/levels";

const contributor = { agentId: "c1", name: "c1", ownerId: "co", tenantId: "tenant", level: "working" as const, burst: false, keyId: "k" };
const reviewer = { agentId: "r1", name: "r1", ownerId: "ro", tenantId: "tenant", level: "working" as const, burst: false, keyId: "k" };
const merger = { agentId: "m1", name: "m1", ownerId: "mo", tenantId: "tenant", level: "manager" as const, burst: false, keyId: "k" };


describe("Role-based discovery functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("findReadyToMergeIssues", () => {
    it("needs a manager agent", async () => {
      await expect(findReadyToMergeIssues(contributor, "p1")).rejects.toBeInstanceOf(AgentLevelError);
    });

    it("returns ready to merge issues when conditions are met", async () => {
      db.bug.findMany.mockResolvedValue([
        {
          id: "bug-1",
          number: 101,
          title: "PR ready to merge",
          projectId: "p1",
          pullRequestUrl: "https://github.com/org/repo/pull/1",
          pullRequestHeadSha: "sha-1",
          reporterId: "user-1",
          beneficiaryUserId: "user-1",
          createdByAgentId: null,
          createdAt: new Date(),
          claims: [{ status: "active", releasedAt: null, agentId: "solver-1", beneficiaryUserId: "user-2", agent: { ownerUserId: "user-2" } }],
          testVerdicts: [
            { id: "v1", onBehalfOfUserId: "rev-1", pullRequestUrl: "https://github.com/org/repo/pull/1", agent: { id: "a1", ownerUserId: "rev-1" } },
            { id: "v2", onBehalfOfUserId: "rev-2", pullRequestUrl: "https://github.com/org/repo/pull/1", agent: { id: "a2", ownerUserId: "rev-2" } },
          ],
        },
      ]);

      const issues = await findReadyToMergeIssues(merger, "p1");
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        id: "bug-1",
        number: 101,
        verdictsCount: 2,
      });
    });

    it("counts verdicts by the merge gate's rule: the reporter's verdict doesn't count", async () => {
      db.bug.findMany.mockResolvedValue([
        {
          id: "bug-self",
          number: 104,
          title: "Reporter tested it",
          projectId: "p1",
          pullRequestUrl: "https://github.com/org/repo/pull/4",
          pullRequestHeadSha: "sha-4",
          reviewStatus: null,
          reporterId: "user-1",
          beneficiaryUserId: "user-1",
          createdByAgentId: null,
          createdAt: new Date(),
          claims: [{ status: "active", releasedAt: null, agentId: "solver-1", beneficiaryUserId: "user-2", agent: { ownerUserId: "user-2" } }],
          testVerdicts: [
            { id: "v1", onBehalfOfUserId: "user-1", pullRequestUrl: "https://github.com/org/repo/pull/4", agent: { id: "a0", ownerUserId: "user-1" } },
            { id: "v2", onBehalfOfUserId: "rev-2", pullRequestUrl: "https://github.com/org/repo/pull/4", agent: { id: "a2", ownerUserId: "rev-2" } },
          ],
        },
      ]);
      // One independent verdict of the two needed: the gate would refuse, so the queue doesn't list it.
      await expect(findReadyToMergeIssues(merger, "p1")).resolves.toEqual([]);
    });

    it("filters by reviewStatus parameter when provided", async () => {
      db.bug.findMany.mockResolvedValue([
        {
          id: "bug-accepted",
          number: 102,
          title: "Accepted PR",
          projectId: "p1",
          pullRequestUrl: "https://github.com/org/repo/pull/2",
          pullRequestHeadSha: "sha-2",
          reviewStatus: "ready_to_merge",
          reporterId: "user-1",
          beneficiaryUserId: "user-1",
          createdByAgentId: null,
          createdAt: new Date(),
          claims: [],
          testVerdicts: [],
        },
      ]);

      const issues = await findReadyToMergeIssues(merger, "p1", 50, "ready_to_merge");
      expect(db.bug.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            // A blocked or failed merge is still waiting on the merger agent.
            AND: [{ reviewStatus: { in: ["ready_to_merge", "merge_blocked", "merge_failed"] } }],
          }),
        }),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].reviewStatus).toBe("ready_to_merge");
    });

    it("matches submitted, tested or not-yet-reviewed fixes without putting null inside `in`, which Prisma rejects", async () => {
      db.bug.findMany.mockResolvedValue([]);
      await findReadyToMergeIssues(merger, "p1", 50, "submitted");
      const where = db.bug.findMany.mock.calls.at(-1)![0].where;
      expect(where.AND).toEqual([{ OR: [{ reviewStatus: { in: ["submitted", "tested"] } }, { reviewStatus: null }] }]);
      expect(JSON.stringify(where)).not.toMatch(/"in":\[[^\]]*null/);
    });

    it("keeps a blocked merge on the list so it can be tried again", async () => {
      db.bug.findMany.mockResolvedValue([
        {
          id: "bug-blocked",
          number: 103,
          title: "Blocked merge",
          projectId: "p1",
          pullRequestUrl: "https://github.com/org/repo/pull/3",
          pullRequestHeadSha: "sha-3",
          reviewStatus: "merge_blocked",
          reporterId: "user-1",
          beneficiaryUserId: "user-1",
          createdByAgentId: null,
          createdAt: new Date(),
          claims: [],
          testVerdicts: [],
        },
      ]);

      const issues = await findReadyToMergeIssues(merger, "p1", 50, "ready_to_merge");
      expect(issues).toHaveLength(1);
      expect(issues[0].reviewStatus).toBe("merge_blocked");
    });
  });

  describe("findReviewableIssues", () => {
    it("is open to every working agent", async () => {
      db.bug.findMany.mockResolvedValue([]);
      await expect(findReviewableIssues(contributor, "p1")).resolves.toEqual([]);
    });

    it("finds reviewable issues for validation and testing", async () => {
      db.bug.findMany.mockResolvedValue([
        {
          id: "bug-2",
          number: 102,
          title: "Needs testing",
          projectId: "p1",
          pullRequestUrl: "https://github.com/org/repo/pull/2",
          reporterId: "user-1",
          beneficiaryUserId: "user-1",
          createdByAgentId: null,
          createdAt: new Date(),
          claims: [],
        },
      ]);

      const issues = await findReviewableIssues(reviewer, "p1", "test");
      expect(issues).toHaveLength(1);
      expect(issues[0].reviewType).toBe("test");
    });
  });

  describe("findClaimableIssues", () => {
    it("is open to every working agent", async () => {
      db.bug.findMany.mockResolvedValue([]);
      await expect(findClaimableIssues(contributor, "p1", 25, new Map())).resolves.toEqual([]);
    });

    it("finds confirmed issues available for bidding or claiming", async () => {
      db.bug.findMany.mockResolvedValue([
        {
          id: "bug-4",
          number: 104,
          title: "Ready to work",
          projectId: "p1",
          voteCount: 4,
          severity: "high",
          createdAt: new Date(),
        },
      ]);

      // Readiness comes from one confirmation read; only ready ids reach the query (#714).
      const confirmations = new Map([
        ["bug-4", { stage: "ready" as const, accepts: 2, needed: 2, triageCleared: true }],
        ["bug-5", { stage: "confirming" as const, accepts: 1, needed: 2, triageCleared: false }],
      ]);
      const issues = await findClaimableIssues(contributor, "p1", 25, confirmations);
      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe("bug-4");
      expect(db.bug.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["bug-4"] } }),
        take: 25,
      }));
    });

    it("returns nothing without querying issues when none is ready", async () => {
      const confirmations = new Map([["bug-5", { stage: "confirming" as const, accepts: 0, needed: 2, triageCleared: false }]]);
      await expect(findClaimableIssues(contributor, "p1", 25, confirmations)).resolves.toEqual([]);
      expect(db.bug.findMany).not.toHaveBeenCalled();
    });
  });
});
