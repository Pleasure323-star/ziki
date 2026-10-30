import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  idea: { findMany: vi.fn(), findFirst: vi.fn(), findUniqueOrThrow: vi.fn() },
  projectWorkflow: { findUnique: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { ideaJson, listAgentIdeas, readAgentIdea } from "./ideas";
import { encodeCursor } from "./create-policy";

const scope = { tenantId: "t1", projectId: "p1" };
const row = {
  id: "i1",
  number: 12,
  title: "Export activity as CSV",
  summary: "People want to export their activity as a CSV file.",
  description: "People want their data.",
  status: "open" as const,
  score: 3,
  typeId: null,
  categoryId: null,
  areaId: null,
  proofLinks: [],
  projectId: "p1",
  reporterId: "ada",
  beneficiaryUserId: "ada",
  createdByAgentId: null,
  convertedAt: null,
  createdAt: new Date("2026-10-20T10:00:00Z"),
  updatedAt: new Date("2026-10-20T10:00:00Z"),
  area: null,
  issue: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.projectWorkflow.findUnique.mockResolvedValue(null);
  db.idea.findMany.mockResolvedValue([row]);
  db.idea.findFirst.mockResolvedValue({ id: "i1" });
  db.idea.findUniqueOrThrow.mockResolvedValue({ ...row, attachments: [] });
});

describe("ideaJson (#idea-table)", () => {
  it("names the issue an idea became, and says when it can be converted", () => {
    expect(ideaJson(row, 3)).toMatchObject({ issueId: null, issueNumber: null, ideaThreshold: 3, convertible: true });
    expect(ideaJson({ ...row, score: 2 }, 3).convertible).toBe(false);
    const converted = ideaJson({ ...row, status: "converted", issue: { id: "b9", number: 42 } }, 3);
    expect(converted).toMatchObject({ issueId: "b9", issueNumber: 42, convertible: false });
    expect(converted).not.toHaveProperty("issue");
    expect(converted.summary).toBe(row.summary);
  });
});

describe("listAgentIdeas", () => {
  it("lists the project's ideas newest first, by status, and pages them", async () => {
    const cursor = encodeCursor({ id: "prev", createdAt: row.createdAt });
    const page = await listAgentIdeas(scope, new URLSearchParams(`status=open&limit=1&cursor=${cursor}`));
    expect(db.idea.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: "t1",
        projectId: "p1",
        isDeleted: false,
        status: "open",
        OR: [{ createdAt: { lt: row.createdAt } }, { createdAt: row.createdAt, id: { lt: "prev" } }],
      }),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 2,
    }));
    expect(page.items[0]).toMatchObject({ id: "i1", number: 12, convertible: true });
  });

  it("lists the convertible ones: open, at the project's threshold", async () => {
    await listAgentIdeas(scope, new URLSearchParams("convertible=true"));
    expect(db.idea.findMany.mock.calls[0][0].where).toMatchObject({ status: "open", score: { gte: 3 } });
  });

  it("names a bad filter", async () => {
    await expect(listAgentIdeas(scope, new URLSearchParams("status=idea"))).rejects.toMatchObject({ status: 400 });
    await expect(listAgentIdeas(scope, new URLSearchParams("convertible=maybe"))).rejects.toMatchObject({ status: 400 });
    await expect(listAgentIdeas(scope, new URLSearchParams("cursor=bad"))).rejects.toMatchObject({ status: 400 });
    expect(db.idea.findMany).not.toHaveBeenCalled();
  });
});

describe("readAgentIdea", () => {
  it("finds an idea by its number or its id, inside the project", async () => {
    await readAgentIdea(scope, "12");
    expect(db.idea.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { ...scope, isDeleted: false, number: 12 } }));
    await readAgentIdea(scope, "i1");
    expect(db.idea.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { ...scope, isDeleted: false, id: "i1" } }));
  });

  it("is a 404 when the idea is not in the project", async () => {
    db.idea.findFirst.mockResolvedValue(null);
    await expect(readAgentIdea(scope, "12")).rejects.toMatchObject({ status: 404 });
  });
});
