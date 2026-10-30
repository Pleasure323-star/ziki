import { beforeEach, describe, expect, it, vi } from "vitest";

// #425: run as a member of the Zedu tenant.
vi.mock("@/lib/tenant-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-context")>()),
  currentTenantIdFor: vi.fn(async () => "tenant-zedu"),
  defaultProjectIdFor: vi.fn(async () => "project-zedu"),
  tenantIdForUser: vi.fn(async () => "tenant-zedu"),
}));
import { NextRequest } from "next/server";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/project-context", () => ({ activeProjectIdFor: vi.fn().mockResolvedValue("project-zedu") }));
vi.mock("@/lib/lookups", () => ({
  getIssueTypes: vi.fn().mockResolvedValue([]),
  getPlatforms: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    milestone: { findMany: vi.fn().mockResolvedValue([]) },
    projectArea: { findMany: vi.fn().mockResolvedValue([{ id: "area-web", name: "Frontend" }]) },
    bug: {
      findMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
  },
}));

import { auth } from "@/auth";
import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

const authMock = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const requireUserMock = vi.mocked(requireUser) as unknown as ReturnType<typeof vi.fn>;
const findManyBugs = vi.mocked(prisma.bug.findMany) as unknown as ReturnType<typeof vi.fn>;

describe("GET /issues/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "u1" } });
    requireUserMock.mockResolvedValue({ id: "u1", role: "user" });
    findManyBugs.mockResolvedValue([]);
  });

  it("returns 401 when not signed in", async () => {
    authMock.mockResolvedValue(null);
    const req = new NextRequest("http://localhost:3000/issues/export");
    const res = await GET(req);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in" });
  });

  it("returns CSV response with proper headers when signed in", async () => {
    const req = new NextRequest("http://localhost:3000/issues/export");
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toContain('attachment; filename="zedu-issues-');
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const text = await res.text();
    // Headers row
    expect(text).toContain("id,title,status,type,platform,area,reporter,assignee,importance,boosted,created_at,updated_at");
  });

  it("streams rows matching query", async () => {
    findManyBugs.mockResolvedValueOnce([
      {
        id: "bug-1",
        title: "Button broken",
        status: "open",
        voteCount: 5,
        isBoosted: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-02T00:00:00Z"),
        type: { name: "Bug" },
        category: { name: "Web" },
        area: { name: "Frontend" },
        reporter: { name: "Alice" },
        assignee: { name: "Bob" },
      },
    ]);

    const req = new NextRequest("http://localhost:3000/issues/export?status=open");
    const res = await GET(req);
    const text = await res.text();

    expect(text).toContain("bug-1,Button broken,Open,Bug,Web,Frontend,Alice,Bob,5,false");
  });

  it("applies the selected project area to exports", async () => {
    const response = await GET(new NextRequest("http://localhost:3000/issues/export?area=area-web"));
    await response.text();
    expect(findManyBugs.mock.calls[0][0].where).toMatchObject({ areaId: "area-web", projectId: "project-zedu" });
  });

  it("exports only the viewer's tenant (#425)", async () => {
    const res = await GET(new NextRequest("http://localhost:3000/issues/export"));
    await res.text();
    expect(findManyBugs.mock.calls[0][0].where).toMatchObject({ tenantId: "tenant-zedu" });
  });
});

describe("GET /issues/export?format=json (#664)", () => {
  const countBugs = vi.mocked(prisma.bug.count) as unknown as ReturnType<typeof vi.fn>;

  function bug(id: string) {
    return {
      id,
      title: `Title with "quotes", commas\nand a newline ${id}`,
      status: "in_progress",
      voteCount: 5,
      isBoosted: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
      type: { name: "Bug" },
      category: null,
      reporter: { name: "Alice" },
      assignee: null,
    };
  }

  async function exportJson(query = "format=json") {
    const res = await GET(new NextRequest(`http://localhost:3000/issues/export?${query}`));
    return { res, body: JSON.parse(await res.text()) };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "u1" } });
    requireUserMock.mockResolvedValue({ id: "u1", role: "user" });
    findManyBugs.mockResolvedValue([]);
    countBugs.mockResolvedValue(0);
  });

  it("returns a JSON file with the same fields as the CSV", async () => {
    findManyBugs.mockResolvedValueOnce([bug("bug-1")]);
    const { res, body } = await exportJson();

    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toMatch(/filename="zedu-issues-\d{4}-\d{2}-\d{2}\.json"/);
    expect(body).toEqual({
      issues: [
        {
          id: "bug-1",
          title: 'Title with "quotes", commas\nand a newline bug-1',
          status: "in_progress",
          type: "Bug",
          platform: null,
          area: null,
          reporter: "Alice",
          assignee: null,
          importance: 5,
          boosted: true,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-02T00:00:00.000Z",
        },
      ],
      truncated: false,
    });
  });

  it("returns valid JSON with no issues", async () => {
    const { body } = await exportJson();
    expect(body).toEqual({ issues: [], truncated: false });
  });

  it("joins issues across batches into one valid array", async () => {
    findManyBugs
      .mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => bug(`bug-${i}`)))
      .mockResolvedValueOnce([bug("bug-500")]);
    const { body } = await exportJson();
    expect(body.issues).toHaveLength(501);
    expect(body.issues.at(-1).id).toBe("bug-500");
  });

  it("says when the export was cut off at the limit", async () => {
    findManyBugs.mockImplementation(async () => Array.from({ length: 500 }, (_, i) => bug(`bug-${i}`)));
    countBugs.mockResolvedValue(12_000);
    const { body } = await exportJson();
    expect(body.issues).toHaveLength(10_000);
    expect(body.truncated).toBe(true);
    expect(body.total).toBe(12_000);
  });

  it("stays valid JSON and reports an error when the export fails partway", async () => {
    findManyBugs
      .mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => bug(`bug-${i}`)))
      .mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { body } = await exportJson();
    expect(body.issues).toHaveLength(500);
    expect(body.error).toBe("Export failed partway through. Please try again.");
  });

  it("applies the same filters and tenant scope as the CSV", async () => {
    await exportJson("format=json&status=open");
    expect(findManyBugs.mock.calls[0][0].where).toMatchObject({ tenantId: "tenant-zedu", status: "open" });
  });

  it("still returns 401 when not signed in", async () => {
    authMock.mockResolvedValue(null);
    const res = await GET(new NextRequest("http://localhost:3000/issues/export?format=json"));
    expect(res.status).toBe(401);
  });

  it("falls back to CSV for any other format", async () => {
    const res = await GET(new NextRequest("http://localhost:3000/issues/export?format=xml"));
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
  });
});
