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
    status: "open",
    pullRequestUrl: null,
  });
  db.comment.create.mockResolvedValue({
    id: "c-1",
    bugId: "bug-1",
    authorId: "owner-a",
    agentId: "agent-a",
    body: "Please add a test.",
    parentId: null,
    bidId: "bid-1",
    createdAt: new Date(),
  });
  db.comment.findMany.mockResolvedValue([]);
  db.agentAuditEvent.create.mockResolvedValue({});
  db.agentEvent.create.mockResolvedValue({ id: "e1" });
  db.webhookSubscription.findMany.mockResolvedValue([]);
});

describe("no typed comments; comments on the issue itself only while it is Open", () => {
  const params = { params: Promise.resolve({ id: "bug-1" }) };

  it("takes a comment on an Open issue", async () => {
    const res = await POST(postRequest({ body: "A comment on the issue." }), params);
    expect(res.status).toBe(201);
    expect(db.comment.create).toHaveBeenCalledTimes(1);
  });

  it("refuses one at Requires confirmation with 409 use_stage_entry, naming the confirmations route", async () => {
    db.bug.findFirst.mockResolvedValueOnce({
      id: "bug-1", title: "Bug 1", reporterId: "owner-a", assigneeId: null, status: "requires_confirmation", pullRequestUrl: null,
    });
    const res = await POST(postRequest({ body: "A free-standing comment." }), params);
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data).toMatchObject({ error: "use_stage_entry", entryRoute: "POST /api/v1/issues/bug-1/confirmations" });
    expect(db.comment.create).not.toHaveBeenCalled();
  });

  it("refuses type and metadata with a 400 listing the entry routes", async () => {
    const res = await POST(postRequest({ body: "I bid on this issue", type: "bid", metadata: { eta: "2 hours" } }), params);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("comment_has_no_type");
    expect(data.entryRoutes.join(" ")).toMatch(/confirmations.*bid.*test-results.*merge/);
    expect(db.comment.create).not.toHaveBeenCalled();
  });

  it("refuses a ?type= filter", async () => {
    const res = await GET(getRequest("&type=delivery"), params);
    expect(res.status).toBe(400);
    expect(db.comment.findMany).not.toHaveBeenCalled();
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
      data: expect.not.objectContaining({ type: expect.anything() }),
    }));
    expect(db.comment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ bidId: "bid-1", confirmationId: null }),
    }));
  });

  it("refuses a bid that is not on this issue", async () => {
    db.issueBid.findFirst.mockResolvedValue(null);
    const res = await POST(postRequest({ body: "Hello.", bidId: "bid-elsewhere" }), params);
    expect(res.status).toBe(422);
    expect(db.comment.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ parentId: "cmabcdefghijklmnopqrstuvw" }, 422],
    [{ type: "delivery" }, 400],
    [{ confirmationId: "conf-1" }, 422],
  ])("refuses a reply to a bid that also sends %j", async (extra, status) => {
    db.issueBid.findFirst.mockResolvedValue({ beneficiaryUserId: "bidder" });
    db.issueConfirmation.findFirst.mockResolvedValue({ onBehalfOfUserId: "someone" });
    const res = await POST(postRequest({ body: "Hello.", bidId: "bid-1", ...extra }), params);
    expect(res.status).toBe(status);
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
      data: expect.objectContaining({ testVerdictId: "tv-1", mergeReviewId: null }),
    }));
  });

  it("files a plain comment under the merge review", async () => {
    db.mergeReview.findFirst.mockResolvedValue({ onBehalfOfUserId: "manager" });
    const res = await POST(postRequest({ body: "On it.", mergeReviewId: "mr-1" }), params);
    expect(res.status).toBe(201);
    expect(db.comment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ mergeReviewId: "mr-1", testVerdictId: null }),
    }));
  });

  it.each([
    [{ testVerdictId: "tv-elsewhere" }, 422],
    [{ mergeReviewId: "mr-1", parentId: "cmabcdefghijklmnopqrstuvw" }, 422],
    [{ mergeReviewId: "mr-1", type: "delivery" }, 400],
    [{ mergeReviewId: "mr-1", testVerdictId: "tv-1" }, 422],
  ])("refuses %j", async (extra, status) => {
    db.testVerdict.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === "tv-1" ? { onBehalfOfUserId: "tester" } : null));
    db.mergeReview.findFirst.mockResolvedValue({ onBehalfOfUserId: "manager" });
    const res = await POST(postRequest({ body: "Hello.", ...extra }), params);
    expect(res.status).toBe(status);
    expect(db.comment.create).not.toHaveBeenCalled();
  });
});
