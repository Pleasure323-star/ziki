import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findIdleInProgress: vi.fn(), abandonTally: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/agent-api/idle", () => ({ findIdleInProgress: mocks.findIdleInProgress }));
vi.mock("@/lib/agent-api/abandon", () => ({ abandonTally: mocks.abandonTally }));
vi.mock("@/lib/workflow", () => ({ workflowFor: vi.fn(async () => ({ abandonThreshold: 3 })) }));

import { idleWork } from "./work";

const NOW = new Date("2026-10-31T12:00:00Z").getTime();
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000);

const idleIssue = (id: string, number: number, claim: { id: string; beneficiaryUserId: string; agent: { ownerUserId: string } } | null, hours = 3) => ({
  bug: { id, projectId: "p1", updatedAt: hoursAgo(hours) },
  claim: claim && { ...claim, agentId: "a1", claimedAt: hoursAgo(hours), extendedAt: null },
  lastUpdate: hoursAgo(hours),
  windowMinutes: 120,
  number,
  title: `Issue ${number}`,
  pullRequestUrl: null,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.abandonTally.mockResolvedValue({ votes: 1, voters: ["owner-cara"] });
});

describe("idle In progress work in the feed (#idle)", () => {
  it("makes held idle work a sense check and idle work nobody holds a manager's review", async () => {
    mocks.findIdleInProgress.mockResolvedValue([
      idleIssue("b1", 1, { id: "c1", beneficiaryUserId: "owner-ada", agent: { ownerUserId: "owner-ada" } }),
      idleIssue("b2", 2, null, 5),
    ]);
    const { toSenseCheck, toReviewIdle } = await idleWork("t1", "p1", new Set(), NOW);
    expect(toSenseCheck).toEqual([
      { id: "b1", number: 1, title: "Issue 1", votes: 1, threshold: 3, holderOwners: ["owner-ada", "owner-ada"], voters: ["owner-cara"], since: hoursAgo(3) },
    ]);
    expect(toReviewIdle).toEqual([{ id: "b2", number: 2, title: "Issue 2", since: hoursAgo(5), idleHours: 5, pullRequestUrl: null }]);
  });

  it("lists nothing when no In progress work is idle", async () => {
    mocks.findIdleInProgress.mockResolvedValue([]);
    await expect(idleWork("t1", "p1", new Set(), NOW)).resolves.toEqual({ toSenseCheck: [], toReviewIdle: [] });
  });

  it("leaves out a stranded delivery, which is asked as deliver_stranded instead", async () => {
    mocks.findIdleInProgress.mockResolvedValue([
      idleIssue("b1", 1, { id: "c1", beneficiaryUserId: "owner-ada", agent: { ownerUserId: "owner-ada" } }),
      idleIssue("b2", 2, null),
    ]);
    await expect(idleWork("t1", "p1", new Set(["b1", "b2"]), NOW)).resolves.toEqual({ toSenseCheck: [], toReviewIdle: [] });
  });
});
