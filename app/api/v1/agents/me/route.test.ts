import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const requireAgent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/require-agent", async (original) => ({
  ...(await original<typeof import("@/lib/agents/require-agent")>()),
  requireAgent,
}));
const prisma = vi.hoisted(() => ({
  project: { findMany: vi.fn() },
  agent: { findUnique: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma }));

import { GET } from "./route";

describe("GET /api/v1/agents/me (#742)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.project.findMany.mockResolvedValue([
      { id: "project_web", slug: "web", name: "Web" },
      { id: "project_api", slug: "api", name: "API" },
    ]);
    prisma.agent.findUnique.mockResolvedValue({ instructions: null });
  });

  it("returns the project the key is limited to", async () => {
    requireAgent.mockResolvedValue({
      agentId: "agent1",
      name: "Ada's Claude",
      ownerId: "ada",
      tenantId: "tenant_zedu",
      level: "working",
      projectId: "project_web",
      projectSlug: "web",
    });
    const response = await GET(new NextRequest("http://localhost:3000/api/v1/agents/me"));
    expect(response.status).toBe(200);
    expect(response.headers.get("ratelimit-limit")).toBe("600");
    expect(response.headers.get("ratelimit-remaining")).not.toBeNull();
    expect(response.headers.get("ratelimit-reset")).not.toBeNull();
    await expect(response.json()).resolves.toEqual({
      id: "agent1",
      name: "Ada's Claude",
      owner_id: "ada",
      tenant_id: "tenant_zedu",
      level: "working",
      project_id: "project_web",
      project_slug: "web",
      // #work-feed: the one URL the agent is told to watch.
      work_url: expect.stringMatching(/\/web\/work$/),
      next_step: expect.stringContaining("work_url"),
      projects: [
        { id: "project_web", slug: "web", name: "Web" },
        { id: "project_api", slug: "api", name: "API" },
      ],
      instructions: null,
    });
  });

  it("lists the tenant's projects so an unscoped key can discover its projectId (#607)", async () => {
    requireAgent.mockResolvedValue({
      agentId: "agent1", name: "Ada's Claude", ownerId: "ada", tenantId: "tenant_zedu",
      level: "working", projectId: null, projectSlug: null,
    });
    const response = await GET(new NextRequest("http://localhost:3000/api/v1/agents/me"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.projects.map((project: { id: string }) => project.id)).toEqual(["project_web", "project_api"]);
    expect(prisma.project.findMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant_zedu" }, orderBy: { slug: "asc" },
      select: { id: true, slug: true, name: true },
    });
  });

  it("returns the owner's standing instructions (#605)", async () => {
    requireAgent.mockResolvedValue({
      agentId: "agent1", name: "Ada's Claude", ownerId: "ada", tenantId: "tenant_zedu",
      level: "working", projectId: null, projectSlug: null,
    });
    prisma.agent.findUnique.mockResolvedValue({ instructions: "Focus on desktop bugs today." });
    const response = await GET(new NextRequest("http://localhost:3000/api/v1/agents/me"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ instructions: "Focus on desktop bugs today." });
    expect(prisma.agent.findUnique).toHaveBeenCalledWith({ where: { id: "agent1" }, select: { instructions: true } });
  });
});
