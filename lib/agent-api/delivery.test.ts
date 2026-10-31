import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@/lib/agents/require-agent";

const PR = "https://github.com/emerjent/ziki/pull/615";

const db = vi.hoisted(() => {
  const tx = {
    delivery: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    bug: { update: vi.fn() },
    testVerdict: { updateMany: vi.fn() },
    bugActivity: { create: vi.fn() },
  };
  return {
    tx,
    prisma: {
      bug: { findFirst: vi.fn(), findUnique: vi.fn() },
      issueClaim: { findFirst: vi.fn() },
      reviewOffer: { findFirst: vi.fn() },
      agentAuditEvent: { findFirst: vi.fn() },
      delivery: { findMany: vi.fn() },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    },
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: db.prisma }));

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  publish: vi.fn(),
  createReviewOffers: vi.fn(async () => ({ offers: [] })),
  strandedDelivery: vi.fn(),
  refreshJudgedStatus: vi.fn(),
}));
vi.mock("@/lib/agents/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/agent-api/events", () => ({ publish: mocks.publish }));
vi.mock("@/lib/agent-api/review-offer", () => ({ createReviewOffers: mocks.createReviewOffers }));
vi.mock("@/lib/agent-api/stranded-delivery", () => ({ STRANDED_AFTER_MS: 2 * 60 * 60 * 1000, strandedDelivery: mocks.strandedDelivery }));
vi.mock("@/lib/agent-api/tested-status", () => ({ refreshJudgedStatus: mocks.refreshJudgedStatus }));

import { deliverWork } from "./delivery";

const agent = (level: AgentContext["level"], ownerId = "dana"): AgentContext => ({
  agentId: `agent-${ownerId}`,
  name: `${ownerId}'s agent`,
  ownerId,
  tenantId: "t1",
  level,
  burst: false,
  keyId: "k1",
});

const body = (pullRequestUrl = PR) => ({
  pullRequestUrl,
  summary: "Delivers the fix in pull request 615.",
  description: "The pull request was linked by hand before deliveries existed; its judgements say it is good to merge.",
  testResults: "Three independent judgements: good to merge.",
});

const stranded = { pullRequestUrl: PR, creditedUserId: "ada", linkedAt: new Date("2026-10-01T10:00:00Z"), goodVerdicts: 2, needed: 2 };

/** Issue #615: In progress, a pull request linked by hand, assigned to Ada, nobody holding a claim. */
function issue(overrides: { reporterId?: string } = {}) {
  db.prisma.bug.findFirst.mockResolvedValue({
    id: "bug1",
    projectId: "p1",
    status: "in_progress",
    pullRequestUrl: PR,
    project: { repoUrl: "https://github.com/emerjent/ziki", githubInstallationId: null },
  });
  db.prisma.bug.findUnique.mockResolvedValue({
    beneficiaryUserId: "rex",
    reporterId: overrides.reporterId ?? "rex",
    assigneeId: "ada",
    createdByAgent: null,
    claims: [],
  });
}

describe("deliverWork: a manager agent delivers a stranded pull request on the holder's behalf (#stranded-delivery)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    issue();
    db.prisma.issueClaim.findFirst.mockResolvedValue(null);
    db.prisma.reviewOffer.findFirst.mockResolvedValue(null);
    db.prisma.agentAuditEvent.findFirst.mockResolvedValue(null);
    db.prisma.delivery.findMany.mockResolvedValue([
      {
        id: "d1",
        agentId: "agent-dana",
        beneficiaryUserId: "ada",
        summary: body().summary,
        description: body().description,
        pullRequestUrl: PR,
        headSha: null,
        screenshots: [],
        testResults: body().testResults,
        createdAt: new Date(),
        updatedAt: new Date(),
        agent: { name: "dana's agent" },
        beneficiary: { name: "Ada" },
        replies: [],
      },
    ]);
    db.tx.delivery.findUnique.mockResolvedValue(null);
    db.tx.delivery.create.mockResolvedValue({ id: "d1" });
    mocks.strandedDelivery.mockResolvedValue(stranded);
    mocks.refreshJudgedStatus.mockResolvedValue("done");
  });

  it("files the delivery as the manager agent, credits the holder, marks it on their behalf and evaluates the judgements at once", async () => {
    const result = await deliverWork(agent("manager"), "bug1", body(), { client: null });
    expect(result).toMatchObject({ status: 201, replaced: false });
    expect(db.tx.delivery.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bugId: "bug1", agentId: "agent-dana", beneficiaryUserId: "ada", pullRequestUrl: PR }) }),
    );
    expect(db.tx.bug.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "delivered" }) }));
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      "issue.delivered",
      "bug:bug1",
      expect.objectContaining({ onBehalfOf: true, filedBy: "agent-dana", creditedUserId: "ada" }),
      expect.anything(),
    );
    expect(mocks.refreshJudgedStatus).toHaveBeenCalledWith(db.prisma, "bug1", "dana");
    // Already Done on the existing judgements: no reviewers are asked for more.
    expect(mocks.createReviewOffers).not.toHaveBeenCalled();
  });

  it("asks for reviewers when the existing judgements leave it Delivered", async () => {
    mocks.refreshJudgedStatus.mockResolvedValue(null);
    expect(await deliverWork(agent("merger"), "bug1", body(), { client: null })).toMatchObject({ status: 201 });
    expect(mocks.createReviewOffers).toHaveBeenCalled();
  });

  it("answers 409 not_stranded to a manager when the issue doesn't qualify", async () => {
    mocks.strandedDelivery.mockResolvedValue(null);
    const result = await deliverWork(agent("manager"), "bug1", body(), { client: null });
    expect(result).toMatchObject({ status: 409, error: "not_stranded" });
    expect((result as { message: string }).message).toMatch(/linked more than 2 hours ago/);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("keeps 409 no_claim for a working agent without a claim, even on a stranded issue", async () => {
    expect(await deliverWork(agent("working"), "bug1", body(), { client: null })).toMatchObject({ status: 409, error: "no_claim" });
    expect(mocks.strandedDelivery).not.toHaveBeenCalled();
  });

  it("refuses a manager that is not independent of the issue or of the person credited", async () => {
    // The credited person's own manager agent.
    expect(await deliverWork(agent("manager", "ada"), "bug1", body(), { client: null })).toMatchObject({ status: 403, error: "not_independent" });
    // The reporter's manager agent.
    issue({ reporterId: "rex" });
    expect(await deliverWork(agent("manager", "rex"), "bug1", body(), { client: null })).toMatchObject({ status: 403, error: "not_independent" });
    // Credited through the agent that linked it, who is neither reporter nor assignee.
    mocks.strandedDelivery.mockResolvedValue({ ...stranded, creditedUserId: "lin" });
    expect(await deliverWork(agent("manager", "lin"), "bug1", body(), { client: null })).toMatchObject({ status: 403, error: "not_independent" });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("answers 409 wrong_pull_request unless it delivers the linked pull request", async () => {
    const result = await deliverWork(agent("manager"), "bug1", body("https://github.com/emerjent/ziki/pull/700"), { client: null });
    expect(result).toMatchObject({ status: 409, error: "wrong_pull_request", field: "pullRequestUrl" });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("leaves the claim holder's own delivery as it was: no stranded check and no immediate evaluation", async () => {
    db.prisma.issueClaim.findFirst.mockResolvedValue({ id: "c1", beneficiaryUserId: "ada" });
    expect(await deliverWork(agent("working", "ada"), "bug1", body(), { client: null })).toMatchObject({ status: 201 });
    expect(mocks.strandedDelivery).not.toHaveBeenCalled();
    expect(mocks.refreshJudgedStatus).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), "issue.delivered", "bug:bug1", expect.not.objectContaining({ onBehalfOf: true }), expect.anything());
    expect(mocks.createReviewOffers).toHaveBeenCalled();
  });
});
