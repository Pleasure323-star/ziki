import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const db = vi.hoisted(() => ({
  project: { findFirst: vi.fn() }, membership: { findUnique: vi.fn() }, bug: { findFirst: vi.fn() },
  redesignProposal: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  attachment: { updateMany: vi.fn() },
  agentApiKey: { findUnique: vi.fn() }, agentAuditEvent: { create: vi.fn() }, $transaction: vi.fn(),
}));
const mocks = vi.hoisted(() => ({ publish: vi.fn(), notify: vi.fn(), session: vi.fn(), tenant: vi.fn(), budget: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/events", () => ({ publish: mocks.publish }));
vi.mock("@/lib/agent-notifications", () => ({ notifyApprovalNeeded: mocks.notify }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: mocks.session }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: async () => ({ id: "human" }) }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock("@/lib/tenant-context", () => ({ currentTenantIdFor: mocks.tenant, defaultProjectIdFor: async () => "project" }));
vi.mock("@/lib/agents/rate-budget", async (original) => ({ ...await original<typeof import("@/lib/agents/rate-budget")>(), consumeAgentBudget: mocks.budget }));
import { assertRedesignOpen, decideRedesign, redesignSchema } from "./redesigns";
import { POST as propose } from "@/app/api/v1/redesigns/route";
import { POST as decide } from "@/app/api/v1/redesigns/[id]/decision/route";
import RedesignsPage from "@/app/(app)/redesigns/page";

const input = { projectId: "project", title: "A better layout", body: "A thoughtful redesign proposal.", onBehalfOfUserId: "beneficiary", bugId: "issue" };
const proposal = { ...input, id: "proposal", tenantId: "tenant", authorAgentId: "agent", status: "proposed" };
const context = { params: Promise.resolve({ id: "proposal" }) };
function request(body: unknown, key = false, origin?: string) {
  return new NextRequest("http://localhost/api/v1/redesigns", { method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(key ? { authorization: "Bearer ziki_test" } : {}), ...(origin ? { origin } : {}) },
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  db.project.findFirst.mockResolvedValue({ id: "project" });
  db.membership.findUnique.mockResolvedValue({ userId: "human" });
  db.bug.findFirst.mockResolvedValue({ id: "issue" });
  db.redesignProposal.create.mockResolvedValue(proposal);
  db.redesignProposal.findFirst.mockResolvedValue(proposal);
  db.redesignProposal.findMany.mockResolvedValue([proposal]);
  db.redesignProposal.updateMany.mockResolvedValue({ count: 1 });
  db.redesignProposal.count.mockResolvedValue(0);
  db.attachment.updateMany.mockResolvedValue({ count: 0 });
  db.agentApiKey.findUnique.mockResolvedValue({ id: "key", revokedAt: null, agent: {
    id: "agent", name: "Helper", ownerUserId: "owner", tenantId: "tenant", level: "working", burst: false, revokedAt: null, owner: { memberships: [{ tenantId: "tenant" }] },
  } });
  db.$transaction.mockImplementation((run) => run(db));
  mocks.session.mockResolvedValue({ userId: "human" });
  mocks.tenant.mockResolvedValue("tenant");
  mocks.budget.mockResolvedValue({ allowed: true });
});

describe("redesign proposal creation", () => {
  it("records the agent and beneficiary, emits an event and notifies the person", async () => {
    expect((await propose(request(input, true))).status).toBe(201);
    expect(db.redesignProposal.create).toHaveBeenCalledWith({ data: expect.objectContaining({ authorAgentId: "agent", onBehalfOfUserId: "beneficiary", tenantId: "tenant", status: "proposed" }) });
    expect(mocks.publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "redesign.proposed", tenantId: "tenant" }));
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ onBehalfOfUserId: "beneficiary", agent: { name: "Helper" } }));
  });
  it("links up to five beneficiary-owned image uploads to the proposal", async () => {
    db.attachment.updateMany.mockResolvedValueOnce({ count: 1 });
    expect((await propose(request({ ...input, attachmentIds: ["mockup"] }, true))).status).toBe(201);
    expect(db.attachment.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["mockup"] }, uploaderId: "beneficiary", bugId: null, commentId: null, redesignProposalId: null, contentType: { startsWith: "image/" } },
      data: { redesignProposalId: "proposal" },
    });
  });
  it("requires an agent key and valid input", async () => {
    expect((await propose(request(input))).status).toBe(401);
    expect((await propose(request({}, true))).status).toBe(400);
    expect(db.redesignProposal.create).not.toHaveBeenCalled();
  });
  it("checks project, beneficiary membership, and linked issue scope", async () => {
    db.project.findFirst.mockResolvedValueOnce(null);
    expect((await propose(request(input, true))).status).toBe(404);
    db.membership.findUnique.mockResolvedValueOnce(null);
    expect((await propose(request(input, true))).status).toBe(422);
    db.bug.findFirst.mockResolvedValueOnce(null);
    expect((await propose(request(input, true))).status).toBe(404);
    expect(db.bug.findFirst).toHaveBeenCalledWith({ where: { id: "issue", tenantId: "tenant", projectId: "project", isDeleted: false }, select: { id: true } });
    expect(db.redesignProposal.create).not.toHaveBeenCalled();
  });
  it("refuses a key restricted to another project (#412)", async () => {
    const key = await db.agentApiKey.findUnique();
    db.agentApiKey.findUnique.mockResolvedValue({ ...key, projectId: "other-project", project: { slug: "other" } });
    const response = await propose(request(input, true));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "project_forbidden" });
    expect(db.project.findFirst).not.toHaveBeenCalled();
    expect(db.redesignProposal.create).not.toHaveBeenCalled();
  });
  it("lets a key restricted to the same project propose (#412)", async () => {
    const key = await db.agentApiKey.findUnique();
    db.agentApiKey.findUnique.mockResolvedValue({ ...key, projectId: "project", project: { slug: "project" } });
    expect((await propose(request(input, true))).status).toBe(201);
  });
  it("accepts HTTPS previews and up to five image attachment ids only", () => {
    expect(redesignSchema.safeParse({ ...input, previewUrl: "https://figma.com/file/example", attachmentIds: ["file1", "file2"] }).success).toBe(true);
    expect(redesignSchema.safeParse({ ...input, previewUrl: "http://figma.com/file/example" }).success).toBe(false);
    expect(redesignSchema.safeParse({ ...input, attachmentIds: ["1", "2", "3", "4", "5", "6"] }).success).toBe(false);
  });
});

describe("human approval rule", () => {
  it("refuses agent keys even with a valid human session", async () => {
    expect((await decide(request({ decision: "approved" }, true), context)).status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(db.redesignProposal.updateMany).not.toHaveBeenCalled();
  });
  it("requires a current session, tenant membership, same origin and valid decision", async () => {
    mocks.session.mockResolvedValueOnce({ error: "expired" });
    expect((await decide(request({ decision: "approved" }), context)).status).toBe(401);
    mocks.tenant.mockResolvedValueOnce(null);
    expect((await decide(request({ decision: "approved" }), context)).status).toBe(403);
    expect((await decide(request({ decision: "approved" }, false, "https://other.test"), context)).status).toBe(403);
    expect((await decide(request({ decision: "anything" }), context)).status).toBe(400);
    db.membership.findUnique.mockResolvedValueOnce(null);
    expect((await decide(request({ decision: "approved" }), context)).status).toBe(403);
    expect(db.redesignProposal.updateMany).not.toHaveBeenCalled();
  });
  it("records the approver/time, audit and event atomically", async () => {
    db.membership.findUnique.mockResolvedValue({ userId: "human", role: "admin" });
    db.redesignProposal.findFirst.mockResolvedValueOnce({
      ...proposal,
      bugId: null,
      authorAgent: { ownerUserId: "owner" },
    });
    const response = await decide(request({ decision: "approved" }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(db.redesignProposal.updateMany).toHaveBeenCalledWith({ where: { id: "proposal", tenantId: "tenant", status: "proposed" }, data: { status: "approved", approverId: "human", approvedAt: expect.any(Date) } });
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "redesign.approved", actorUserId: "human", agentId: "agent" }) });
    expect(mocks.publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "redesign.approved", payload: expect.objectContaining({ actorUserId: "human" }) }));
  });
  it("lets a tenant admin choose a linked design and supersedes its alternatives", async () => {
    db.membership.findUnique.mockResolvedValue({ userId: "human", role: "admin" });
    db.redesignProposal.findFirst.mockResolvedValue({
      ...proposal,
      bugId: "issue",
      authorAgent: { ownerUserId: "owner" },
    });
    db.redesignProposal.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 2 });
    const result = await decideRedesign("human", "tenant", "proposal", "chosen");
    expect(result).toMatchObject({ id: "proposal", status: "approved", supersededCount: 2 });
    expect(db.redesignProposal.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: { id: "proposal", tenantId: "tenant", status: "proposed" }, data: expect.objectContaining({ status: "approved", approverId: "human" }) }));
    expect(db.redesignProposal.updateMany).toHaveBeenNthCalledWith(2, { where: { tenantId: "tenant", bugId: "issue", id: { not: "proposal" }, status: "proposed" }, data: { status: "superseded" } });
    expect(mocks.publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "redesign.chosen", payload: expect.objectContaining({ winningProposalId: "proposal", supersededCount: 2 }) }));
  });
  it("requires linked proposals to be chosen from the issue comparison", async () => {
    db.membership.findUnique.mockResolvedValue({ userId: "human", role: "admin" });
    db.redesignProposal.findFirst.mockResolvedValue({ ...proposal, authorAgent: { ownerUserId: "owner" } });
    await expect(decideRedesign("human", "tenant", "proposal", "approved")).rejects.toThrow();
    expect(db.redesignProposal.updateMany).not.toHaveBeenCalled();
  });
  it("requires a tenant admin to choose a proposal", async () => {
    expect((await decide(request({ decision: "chosen" }), context)).status).toBe(403);
    expect(db.redesignProposal.updateMany).not.toHaveBeenCalled();
  });
  it("lets a workspace admin reject without recording approval", async () => {
    db.membership.findUnique.mockResolvedValue({ userId: "human", role: "admin" });
    db.redesignProposal.findFirst.mockResolvedValue({ ...proposal, authorAgent: { ownerUserId: "owner" } });
    expect((await decide(request({ decision: "rejected" }), context)).status).toBe(200);
    expect(db.redesignProposal.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "rejected", approverId: null, approvedAt: null } }));
  });
  it("hides other tenants and prevents conflicting decisions", async () => {
    db.membership.findUnique.mockResolvedValue({ userId: "human", role: "admin" });
    db.redesignProposal.findFirst.mockResolvedValueOnce(null);
    expect((await decide(request({ decision: "approved" }), context)).status).toBe(404);
    db.redesignProposal.findFirst.mockResolvedValueOnce({
      ...proposal,
      bugId: null,
      authorAgent: { ownerUserId: "owner" },
    });
    db.redesignProposal.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await decide(request({ decision: "approved" }), context)).status).toBe(409);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(db.redesignProposal.findFirst).toHaveBeenCalledWith({
      where: { id: "proposal", tenantId: "tenant" },
      include: { authorAgent: { select: { ownerUserId: true } } },
    });
  });
  it("refuses the proposing agent's owner", async () => {
    db.membership.findUnique.mockResolvedValue({ userId: "human", role: "admin" });
    db.redesignProposal.findFirst.mockResolvedValue({
      ...proposal,
      bugId: null,
      authorAgent: { ownerUserId: "human" },
    });
    expect((await decide(request({ decision: "approved" }), context)).status).toBe(403);
    expect(db.redesignProposal.updateMany).not.toHaveBeenCalled();
  });
  it("returns a storage failure without a successful decision", async () => {
    db.membership.findUnique.mockResolvedValue({ userId: "human", role: "admin" });
    db.redesignProposal.findFirst.mockRejectedValueOnce(new Error("DB"));
    expect((await decide(request({ decision: "approved" }), context)).status).toBe(503);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});

describe("claim gate and human page", () => {
  it("blocks pending redesigns and allows rejected, approved, or unlinked issues", async () => {
    db.redesignProposal.count.mockResolvedValueOnce(1);
    await expect(assertRedesignOpen("issue", db as never)).rejects.toThrow();
    await expect(assertRedesignOpen("issue", db as never)).resolves.toBeUndefined();
    await expect(assertRedesignOpen("issue", db as never)).resolves.toBeUndefined();
    await expect(assertRedesignOpen("issue", db as never)).resolves.toBeUndefined();
    expect(db.redesignProposal.count).toHaveBeenCalledTimes(4);
    expect(db.redesignProposal.count).toHaveBeenCalledWith({ where: { bugId: "issue", status: "proposed" } });
  });
  it("sends the redesign list to the Redesign type on escalations", () => {
    expect(() => RedesignsPage()).toThrow("redirect:/escalations?type=Redesign");
  });
});
