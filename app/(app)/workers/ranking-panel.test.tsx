// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import axe from "axe-core";

const currentTenantIdFor = vi.hoisted(() => vi.fn());
const requireUser = vi.hoisted(() => vi.fn());
const projectContextFor = vi.hoisted(() => vi.fn());
const leaderboard = vi.hoisted(() => vi.fn());
const rankFor = vi.hoisted(() => vi.fn());
const totals = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  }),
);

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/tenant-context", () => ({ currentTenantIdFor }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser }));
vi.mock("@/lib/project-context", () => ({ projectContextFor }));
vi.mock("@/lib/workflow", () => ({ workflowFor: vi.fn(async () => ({ maxActiveClaims: 2 })) }));
vi.mock("@/lib/points/platform-rewards", () => ({ getPlatformRewardConfig: vi.fn(async () => ({ target: 500 })) }));
vi.mock("@/lib/points/leaderboard", () => ({
  DEFAULT_LEADERBOARD_LIMIT: 50,
  paginatedTenantLeaderboard: leaderboard,
  tenantRankFor: rankFor,
  pointTotals: totals,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    membership: { findMany: vi.fn() },
    projectArea: { findMany: vi.fn() },
    agent: { findMany: vi.fn() },
    issueClaim: { findMany: vi.fn(), groupBy: vi.fn() },
    pointEntry: { groupBy: vi.fn() },
    bug: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import RankingPanel from "./ranking-panel";

const entry = (
  rank: number,
  overrides: Partial<{ userId: string; name: string; points: number; solvedTasks: number }> = {},
) => ({
  userId: overrides.userId ?? `u${rank}`,
  name: overrides.name ?? `Person ${rank}`,
  image: null,
  points: overrides.points ?? 100 - rank,
  solvedTasks: overrides.solvedTasks ?? 1,
  rank,
});

const member = (id: string, name: string, role = "member") => ({ role, user: { id, name, image: null } });

function board(entries: ReturnType<typeof entry>[]) {
  leaderboard.mockResolvedValue({ entries, total: entries.length, page: 1, limit: 100, totalPages: 1 });
}

async function render(params: Record<string, string> = {}) {
  return renderToStaticMarkup((await RankingPanel({ searchParams: Promise.resolve(params) })) as ReactElement);
}

/** The names in the Team list, top to bottom. */
function listOrder(html: string): string[] {
  const list = html.slice(html.indexOf('aria-label="Team"'));
  return [...list.matchAll(/href="\/users\/[^"]+">([^<]+)</g)].map((m) => m[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: "viewer-1" });
  currentTenantIdFor.mockResolvedValue("tenant-1");
  projectContextFor.mockResolvedValue({ activeProjectId: "project-1" });
  rankFor.mockResolvedValue(null);
  totals.mockResolvedValue({ points: 0, solvedTasks: 0 });
  board([]);
  vi.mocked(prisma.membership.findMany).mockResolvedValue([
    member("viewer-1", "Ada"),
    member("member-2", "Grace", "admin"),
  ] as never);
  vi.mocked(prisma.agent.findMany).mockResolvedValue([
    {
      id: "agent-1",
      ownerUserId: "viewer-1",
      name: "Ada's agent",
      model: "Claude",
      level: "working",
      apiKeys: [{ lastUsedAt: null }],
      claims: [{
        claimedAt: new Date(),
        lastHeartbeatAt: new Date(),
        bug: { id: "issue-1", title: "Fix the app", categoryId: "cat-web", category: { name: "Web" }, areaId: "area-1", area: { name: "Checkout" } },
      }],
    },
  ] as never);
  vi.mocked(prisma.issueClaim.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.issueClaim.groupBy).mockResolvedValue([
    { beneficiaryUserId: "viewer-1", _count: { _all: 1 } },
  ] as never);
  vi.mocked(prisma.pointEntry.groupBy).mockResolvedValue([
    { userId: "viewer-1", _sum: { points: 12 } },
  ] as never);
  vi.mocked(prisma.bug.findMany).mockResolvedValue([] as never);
});

describe("ranking: leaderboard on top", () => {
  it("shows the top-3 podium, your standing, and Points/Solved sort", async () => {
    requireUser.mockResolvedValue({ id: "ann" });
    rankFor.mockResolvedValue({ rank: 1, total: 3 });
    totals.mockResolvedValue({ points: 516, solvedTasks: 3 });
    vi.mocked(prisma.membership.findMany).mockResolvedValue([
      member("ann", "Ann"), member("u2", "Bo"), member("u3", "Cy"),
    ] as never);
    board([
      entry(1, { userId: "ann", name: "Ann", points: 516, solvedTasks: 3 }),
      entry(2, { name: "Bo", points: 396, solvedTasks: 0 }),
      entry(3, { name: "Cy", points: 342, solvedTasks: 5 }),
    ]);
    const html = await render();
    expect(html).toContain("Your standing");
    expect(html).toContain("of 3 people");
    expect(html).toContain("120 pts ahead of #2");
    expect(html).toContain("Goal reached · +16");
    expect(html).toContain('aria-label="Sort by"');
    expect(html).toContain('href="/workers?page=1&amp;limit=50&amp;sort=solved"');
    expect(listOrder(html)).toEqual(["Ann", "Bo", "Cy"]);
    expect(html).toContain(">You<");
  });

  it("re-orders the list when sort=solved", async () => {
    vi.mocked(prisma.membership.findMany).mockResolvedValue([
      member("u1", "Ann"), member("u2", "Bo"), member("u3", "Cy"),
    ] as never);
    board([
      entry(1, { name: "Ann", points: 516, solvedTasks: 3 }),
      entry(2, { name: "Bo", points: 396, solvedTasks: 0 }),
      entry(3, { name: "Cy", points: 342, solvedTasks: 5 }),
    ]);
    expect(listOrder(await render({ sort: "solved" }))).toEqual(["Cy", "Ann", "Bo"]);
  });

  it("says there are no points yet but still lists the whole team", async () => {
    const html = await render();
    expect(html).toContain("No points yet");
    expect(html).not.toContain("Your standing");
    expect(listOrder(html)).toEqual(["Ada", "Grace"]);
  });
});

describe("ranking: the whole team below", () => {
  it("lists members without points after everyone ranked, with no rank", async () => {
    board([entry(1, { userId: "member-2", name: "Grace", points: 80 })]);
    const html = await render();
    expect(listOrder(html)).toEqual(["Grace", "Ada"]);
    expect(html).toContain("—");
  });

  it("adds the Team details: role, recent points, claims and agents with their work", async () => {
    const html = await render();
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(html).toContain(">Admin<");
    expect(html).toContain("+12 in 30d");
    expect(html).toMatch(/1<span[^>]*> \/ 2<\/span>/);
    const toggle = doc.querySelector('button[aria-controls="team-agents-viewer-1"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    const agents = doc.getElementById("team-agents-viewer-1");
    expect(agents?.hasAttribute("hidden")).toBe(true);
    expect(agents?.querySelector('a[href="/issues/issue-1"]')).not.toBeNull();
    expect(doc.querySelector(".team-agent-role")?.textContent).toBe("Working agent");
    expect(html).toContain("No agents");
    expect(html).toContain("active claims count the selected project");
  });

  it("counts an agent's work and lists unclaimed assigned issues once for the member (Ziki #447)", async () => {
    vi.mocked(prisma.bug.findMany).mockResolvedValue([
      // Claimed by Ada's agent and assigned to Ada: stays on the agent's row only.
      { id: "issue-1", title: "Fix the app", assigneeId: "viewer-1", categoryId: null, category: null, areaId: null, area: null },
      { id: "issue-2", title: "Assigned by hand", assigneeId: "viewer-1", categoryId: null, category: null, areaId: null, area: null },
    ] as never);
    const html = await render();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const panel = doc.getElementById("team-agents-viewer-1");
    expect(panel?.querySelector(".team-agent-table")?.textContent).toContain("Working on 1 issue");
    expect(panel?.textContent).toContain("Assigned, no agent claim (1)");
    expect(panel?.querySelectorAll('a[href="/issues/issue-1"]')).toHaveLength(1);
    expect(panel?.querySelectorAll('a[href="/issues/issue-2"]')).toHaveLength(1);
    expect(prisma.bug.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", isDeleted: false, status: { in: ["requires_confirmation", "open", "in_progress"] }, assigneeId: { in: ["viewer-1", "member-2"] } },
    }));
  });

  it("scopes every read to the workspace and the active project", async () => {
    await render();
    expect(prisma.membership.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-1" } }));
    expect(prisma.issueClaim.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ bug: { tenantId: "tenant-1", projectId: "project-1" } }),
    }));
    expect(prisma.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", ownerUserId: { in: ["viewer-1", "member-2"] }, revokedAt: null },
    }));
    expect(prisma.projectArea.findMany).not.toHaveBeenCalled();
  });

  it("filters by online status and capacity, with toggles that keep the other filter", async () => {
    const html = await render({ online: "1", capacity: "1" });
    expect(listOrder(html)).toEqual(["Ada"]);
    expect(html).toContain("1 of 2 people");
    expect(html).toContain('href="/workers?page=1&amp;limit=50&amp;capacity=1"');
  });

  it("searches by name", async () => {
    expect(listOrder(await render({ q: "gra" }))).toEqual(["Grace"]);
  });

  it("lets a super admin change another person's agent class", async () => {
    requireUser.mockResolvedValue({ id: "viewer-1", role: "super_admin" });
    vi.mocked(prisma.agent.findMany).mockResolvedValue([
      { id: "agent-2", ownerUserId: "member-2", name: "Grace's agent", model: "Claude", level: "working", apiKeys: [{ lastUsedAt: null }], claims: [] },
    ] as never);
    const html = await render();
    expect(html).toContain("change anyone&#x27;s agent class here, including manager and merger");
    expect(html).toContain('aria-label="Agent class for Grace&#x27;s agent"');
    expect(html).toContain(">Merger agent</option>");
  });

  it("does not query or display workspace data without a workspace", async () => {
    currentTenantIdFor.mockResolvedValue(null);
    const html = await render();
    expect(html).toContain("Join or create a workspace");
    expect(prisma.membership.findMany).not.toHaveBeenCalled();
    expect(leaderboard).not.toHaveBeenCalled();
  });
});

describe("ranking pagination", () => {
  beforeEach(() => {
    vi.mocked(prisma.membership.findMany).mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => member(`u${i + 1}`, `Person ${String(i + 1).padStart(2, "0")}`)) as never,
    );
  });

  it("sends a page past the end to the last page, keeping the page size", async () => {
    await expect(render({ page: "99", limit: "10" })).rejects.toMatchObject({ url: "/workers?page=3&limit=10" });
  });

  it("doesn't redirect when there is nothing to page through", async () => {
    vi.mocked(prisma.membership.findMany).mockResolvedValue([] as never);
    expect(await render({ page: "5" })).toContain("This workspace has no members yet.");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("renders a middle page with Previous and Next built the same way", async () => {
    const html = await render({ page: "2", limit: "10" });
    expect(html).toContain("Person 11");
    expect(html).not.toContain("Person 10<");
    expect(html).toContain("Showing 11–20 of 25");
    expect(html).toContain('href="/workers?page=1&amp;limit=10"');
    expect(html).toContain('href="/workers?page=3&amp;limit=10"');
  });

  it("marks Previous as disabled on the first page", async () => {
    expect(await render({ limit: "10" })).toMatch(/<span aria-disabled="true"[^>]*>Previous<\/span>/);
  });
});

describe("ranking accessibility", () => {
  it("passes the accessibility sweep at desktop and 375px widths", async () => {
    board([entry(1, { userId: "viewer-1", name: "Ada", points: 80 })]);
    const html = await render();
    const previousWidth = window.innerWidth;
    window.HTMLCanvasElement.prototype.getContext = (() =>
      ({ font: "", measureText: () => ({ width: 0 }) })) as unknown as typeof window.HTMLCanvasElement.prototype.getContext;
    for (const width of [1280, 375]) {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      document.body.innerHTML = html;
      const { violations } = await axe.run(document.body, {
        rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
      });
      expect(violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
    }
    Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
    document.body.innerHTML = "";
  });
});
