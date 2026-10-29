import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  agentApiKey: { findUnique: vi.fn() },
  agentAuditEvent: { create: vi.fn() },
  project: { findFirst: vi.fn() },
  bug: { findFirst: vi.fn(), update: vi.fn() },
  comment: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  issueBid: { findFirst: vi.fn() },
  testVerdict: { findFirst: vi.fn() },
  mergeReview: { findFirst: vi.fn() },
  issueConfirmation: { findFirst: vi.fn() },
  bugActivity: { create: vi.fn() },
  issueWatch: { upsert: vi.fn() },
  agentEvent: { create: vi.fn() },
  webhookSubscription: { findMany: vi.fn() },
  webhookDelivery: { createMany: vi.fn() },
  $transaction: vi.fn(),
}));

const budget = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/notify", () => ({ notifyLater: vi.fn() }));
vi.mock("@/lib/agents/rate-budget", async (original) => ({
  ...(await original<typeof import("@/lib/agents/rate-budget")>()),
  consumeAgentBudget: budget,
}));

import { POST, GET } from "./route";

const key = {
  id: "key-a",
  revokedAt: null,
  projectId: "proj-1",
  project: { id: "proj-1" },
  agent: {
    id: "agent-a",
    name: "Agent A",
    ownerUserId: "owner-a",
    tenantId: "tenant-a",
    level: "working",
    burst: false,
    revokedAt: null,
    owner: { memberships: [{ tenantId: "tenant-a" }] },
  },
};

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/v1/issues/bug-1/comments?projectId=proj-1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer ziki_test",
    },
    body: JSON.stringify(body),
  });
}

function getRequest(params = "") {
  return new NextRequest(`http://localhost/api/v1/issues/bug-1/comments?projectId=proj-1${params}`, {
    method: "GET",
    headers: { authorization: "Bearer ziki_test" },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((run: (tx: typeof db) => unknown) => run(db));
  db.agentApiKey.findUnique.mockResolvedValue(key);
  budget.mockResolvedValue({ allowed: true });
  db.project.findFirst.mockResolvedValue({ id: "proj-1" });
  db.bug.findFirst.mockResolvedValue({
    id: "bug-1",
    title: "Bug 1",
    reporterId: "owner-a",
    assigneeId: null,
    convertedToIssueAt: new Date("2026-10-19T13:00:00Z"),
  });
  db.comment.create.mockResolvedValue({
    id: "c-1",
    bugId: "bug-1",
    authorId: "owner-a",
    agentId: "agent-a",
    body: "Here is my bid",
    parentId: null,
    type: "bid",
    metadata: { eta: "2 hours" },
    createdAt: new Date(),
  });
  db.comment.findMany.mockResolvedValue([]);
  db.agentAuditEvent.create.mockResolvedValue({});
  db.agentEvent.create.mockResolvedValue({ id: "e1" });
  db.webhookSubscription.findMany.mockResolvedValue([]);
});

describe("Structured Comments API (#747)", () => {
  it("creates a structured bid comment with metadata", async () => {
    const res = await POST(
      postRequest({
        body: "I bid on this issue",
        type: "bid",
        metadata: { eta: "2 hours" },
      }),
      { params: Promise.resolve({ id: "bug-1" }) },
    );

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.comment).toMatchObject({
      id: "c-1",
      type: "bid",
      metadata: { eta: "2 hours" },
    });
    expect(db.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "bid",
          metadata: { eta: "2 hours" },
        }),
      }),
    );
  });

  it("filters comments by type query param", async () => {
    db.comment.findMany.mockResolvedValue([
      {
        id: "c-delivery",
        body: "Delivered PR",
        type: "delivery",
        metadata: { prUrl: "https://github.com/pull/1" },
        authorId: "owner-a",
        agentId: "agent-a",
        parentId: null,
        createdAt: new Date(),
        editedAt: null,
        author: { id: "owner-a", name: "Ada" },
        agent: { id: "agent-a", name: "Agent A" },
      },
    ]);

    const res = await GET(getRequest("&type=delivery"), {
      params: Promise.resolve({ id: "bug-1" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(1);
    expect(data.items[0].type).toBe("delivery");
    expect(db.comment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          bugId: "bug-1",
          type: "delivery",
        }),
      }),
    );
  });
});

describe("replies to a bid (#issue-bids)", () => {
  const params = { params: Promise.resolve({ id: "bug-1" }) };

  it("files a plain comment under the bid", async () => {
    db.issueBid.findFirst.mockResolvedValue({ beneficiaryUserId: "bidder" });
    const res = await POST(postRequest({ body: "Please add a test.", bidId: "bid-1" }), params);
    expect(res.status).toBe(201);
    expect(db.issueBid.findFirst).toHaveBeenCalledWith({ where: { id: "bid-1", bugId: "bug-1" }, select: { beneficiaryUserId: true } });
    expect(db.comment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ bidId: "bid-1", parentId: null, confirmationId: null, type: "comment" }),
    }));
  });

  it("refuses a bid that is not on this issue", async () => {
    db.issueBid.findFirst.mockResolvedValue(null);
    const res = await POST(postRequest({ body: "Hello.", bidId: "bid-elsewhere" }), params);
    expect(res.status).toBe(422);
    expect(db.comment.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ parentId: "cmabcdefghijklmnopqrstuvw" }, "parentId"],
    [{ type: "delivery" }, "type"],
    [{ confirmationId: "conf-1" }, "confirmationId"],
  ])("refuses a reply to a bid that also sends %j (%s)", async (extra, field) => {
    db.issueBid.findFirst.mockResolvedValue({ beneficiaryUserId: "bidder" });
    db.issueConfirmation.findFirst.mockResolvedValue({ onBehalfOfUserId: "someone" });
    const res = await POST(postRequest({ body: "Hello.", bidId: "bid-1", ...extra }), params);
    expect(res.status, field).toBe(422);
    expect(db.comment.create).not.toHaveBeenCalled();
  });
});

describe("replies to a test verdict or a merge review (#review-entries)", () => {
  const params = { params: Promise.resolve({ id: "bug-1" }) };

  it("files a plain comment under the test verdict", async () => {
    db.testVerdict.findFirst.mockResolvedValue({ onBehalfOfUserId: "tester" });
    const res = await POST(postRequest({ body: "Which browser?", testVerdictId: "tv-1" }), params);
    expect(res.status).toBe(201);
    expect(db.testVerdict.findFirst).toHaveBeenCalledWith({ where: { id: "tv-1", bugId: "bug-1" }, select: { onBehalfOfUserId: true } });
    expect(db.comment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ testVerdictId: "tv-1", mergeReviewId: null, parentId: null, type: "comment" }),
    }));
  });

  it("files a plain comment under the merge review", async () => {
    db.mergeReview.findFirst.mockResolvedValue({ onBehalfOfUserId: "manager" });
    const res = await POST(postRequest({ body: "On it.", mergeReviewId: "mr-1" }), params);
    expect(res.status).toBe(201);
    expect(db.comment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ mergeReviewId: "mr-1", testVerdictId: null, parentId: null }),
    }));
  });

  it.each([
    [{ testVerdictId: "tv-elsewhere" }, "a verdict on another issue"],
    [{ mergeReviewId: "mr-1", parentId: "cmabcdefghijklmnopqrstuvw" }, "parentId"],
    [{ mergeReviewId: "mr-1", type: "delivery" }, "type"],
    [{ mergeReviewId: "mr-1", testVerdictId: "tv-1" }, "two entries"],
  ])("refuses %j (%s)", async (extra, label) => {
    db.testVerdict.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === "tv-1" ? { onBehalfOfUserId: "tester" } : null));
    db.mergeReview.findFirst.mockResolvedValue({ onBehalfOfUserId: "manager" });
    const res = await POST(postRequest({ body: "Hello.", ...extra }), params);
    expect(res.status, label).toBe(422);
    expect(db.comment.create).not.toHaveBeenCalled();
  });
});
