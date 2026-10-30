import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  agentApiKey: { findUnique: vi.fn() }, agentAuditEvent: { create: vi.fn() },
  project: { findMany: vi.fn(), findFirst: vi.fn() },
  bug: { groupBy: vi.fn(), count: vi.fn() },
}));
const budget = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agents/rate-budget", async (original) => ({
  ...await original<typeof import("@/lib/agents/rate-budget")>(), consumeAgentBudget: budget,
}));
import { GET as list } from "./route";
import { GET as readOne } from "./[id]/route";

const key = { id: "key-a", revokedAt: null, projectId: "project-web", project: { slug: "web" }, agent: {
  id: "agent-a", name: "Agent A", ownerUserId: "owner-a", tenantId: "tenant-a", level: "working", burst: false, revokedAt: null,
  owner: { memberships: [{ tenantId: "tenant-a" }] },
} };
function request(path = "http://localhost/api/v1/projects", keyHeader = "Bearer ziki_test") {
  return new NextRequest(path, { headers: keyHeader ? { authorization: keyHeader } : {} });
}
beforeEach(() => {
  vi.resetAllMocks();
  db.agentApiKey.findUnique.mockResolvedValue(key);
  budget.mockResolvedValue({ allowed: true });
  db.bug.groupBy.mockResolvedValue([]);
  db.bug.count.mockResolvedValue(0);
  db.project.findMany.mockResolvedValue([]);
  db.project.findFirst.mockResolvedValue(null);
});

describe("agent project discovery (#607)", () => {
  it("lists the tenant's projects with goal, workflow gates and open counts", async () => {
    db.project.findMany.mockResolvedValue([
      { id: "project-web", slug: "web", name: "Web", goal: "Ship Ziki", repoUrl: "https://github.com/web", stagingUrl: "https://stage" },
      { id: "project-api", slug: "api", name: "API", goal: null, repoUrl: null, stagingUrl: null },
    ]);
    db.bug.groupBy.mockResolvedValue([{ projectId: "project-web", _count: { _all: 3 } }]);
    const response = await list(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        { id: "project-web", slug: "web", name: "Web", goal: "Ship Ziki", repoUrl: "https://github.com/web", stagingUrl: "https://stage",
          workUrl: expect.stringMatching(/\/web\/work$/),
          notesUrl: "/api/v1/projects/project-web/notes", notesCommentsUrl: "/api/v1/projects/project-web/notes/comments",
          workflow: {
            confirmationsNeeded: 2, verdictsNeeded: 2, offerWindowSeconds: 1800,
            heartbeatMinutes: 240, deliveryMinutes: 240, maxActiveClaims: 2,
            volunteerWindowSeconds: 120, autoMerge: true, ideaThreshold: 3, abandonCheckMinutes: 360, abandonThreshold: 3, closeThreshold: 3,
          }, openIssueCount: 3,
          rewardRules: { guidelines: null, reporter: 150, reviewer: 300, solver: 750 } },
        { id: "project-api", slug: "api", name: "API", goal: null, repoUrl: null, stagingUrl: null,
          workUrl: expect.stringMatching(/\/api\/work$/),
          notesUrl: "/api/v1/projects/project-api/notes", notesCommentsUrl: "/api/v1/projects/project-api/notes/comments",
          workflow: {
            confirmationsNeeded: 2, verdictsNeeded: 2, offerWindowSeconds: 1800,
            heartbeatMinutes: 240, deliveryMinutes: 240, maxActiveClaims: 2,
            volunteerWindowSeconds: 120, autoMerge: true, ideaThreshold: 3, abandonCheckMinutes: 360, abandonThreshold: 3, closeThreshold: 3,
          }, openIssueCount: 0,
          rewardRules: { guidelines: null, reporter: 150, reviewer: 300, solver: 750 } },
      ],
    });
    expect(db.project.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-a" } }));
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "projects.list" }) }));
  });

  it("returns each project's own workflow settings (#595)", async () => {
    db.project.findMany.mockResolvedValue([
      {
        id: "project-web", slug: "web", name: "Web", goal: null, repoUrl: null, stagingUrl: null,
        workflow: {
          confirmationsNeeded: 3, verdictsNeeded: 4, offerWindowSeconds: 120,
          heartbeatMinutes: 20, deliveryMinutes: 30, maxActiveClaims: 3,
          volunteerWindowSeconds: 300, autoMerge: false,
        },
      },
      {
        id: "project-api", slug: "api", name: "API", goal: null, repoUrl: null, stagingUrl: null,
        workflow: null,
      },
    ]);
    const response = await list(request());
    const body = (await response.json()) as { items: Array<{ id: string; workflow: Record<string, unknown> }> };
    expect(body.items[0].workflow).toMatchObject({
      confirmationsNeeded: 3,
      verdictsNeeded: 4,
      offerWindowSeconds: 120,
      autoMerge: false,
    });
    expect(body.items[1].workflow).toMatchObject({ confirmationsNeeded: 2, autoMerge: true });
  });

  it("never counts another tenant's issues", async () => {
    db.project.findMany.mockResolvedValue([{ id: "project-web", slug: "web", name: "Web", goal: "", repoUrl: "", stagingUrl: "" }]);
    await list(request());
    expect(db.bug.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: "tenant-a", isDeleted: false, status: "open" }) }));
  });

  it("reads one project by id, tenant-scoped; foreign ids are 404", async () => {
    db.project.findFirst.mockResolvedValue({ id: "project-web", slug: "web", name: "Web", goal: "Ship Ziki", repoUrl: null, stagingUrl: null });
    db.bug.count.mockResolvedValue(7);
    const response = await readOne(request("http://localhost/api/v1/projects/project-web"), { params: Promise.resolve({ id: "project-web" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "project-web", goal: "Ship Ziki", openIssueCount: 7,
      workflow: {
        confirmationsNeeded: 2, verdictsNeeded: 2, offerWindowSeconds: 1800,
        heartbeatMinutes: 240, deliveryMinutes: 240, maxActiveClaims: 2,
        volunteerWindowSeconds: 120, autoMerge: true, ideaThreshold: 3, abandonCheckMinutes: 360, abandonThreshold: 3, closeThreshold: 3,
      },
    });
    expect(db.project.findFirst).toHaveBeenCalledWith({ where: { id: "project-web", tenantId: "tenant-a" }, select: expect.objectContaining({ goal: true }) });
    db.project.findFirst.mockResolvedValueOnce(null);
    expect((await readOne(request("http://localhost/api/v1/projects/elsewhere"), { params: Promise.resolve({ id: "elsewhere" }) })).status).toBe(404);
    expect(db.bug.count).toHaveBeenCalledTimes(1);
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "projects.read" }) }));
  });

  it("requires a key and spends the shared read budget", async () => {
    expect((await list(request("http://localhost/api/v1/projects", ""))).status).toBe(401);
    db.agentApiKey.findUnique.mockResolvedValueOnce(null);
    expect((await list(request())).status).toBe(401);
    expect(db.project.findMany).not.toHaveBeenCalled();
    await list(request());
    expect(budget).toHaveBeenLastCalledWith({ id: "agent-a", burst: false, burstUntil: null }, "read");
  });
});
