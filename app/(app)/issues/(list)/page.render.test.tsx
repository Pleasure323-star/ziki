import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/**
 * Renders the whole issue list with a small fake database, so the layout
 * changes from the Oct 20 call (#1054–#1063) are checked on real markup.
 */

const count = vi.hoisted(() => vi.fn());
const findMany = vi.hoisted(() => vi.fn());
// #idea-table: ideas come from their own table, on the Ideas tab.
const ideaCount = vi.hoisted(() => vi.fn());
const ideaFindMany = vi.hoisted(() => vi.fn());
// Each idea's votes by opinion, to mark bad ideas red (#idea-rejected).
const ideaVerdictGroupBy = vi.hoisted(() => vi.fn());
const groupBy = vi.hoisted(() => vi.fn(async (_args: { by: string[]; where?: Record<string, unknown> }) => {
  void _args;
  return [];
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/issues",
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "dave" } })) }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: vi.fn(async () => ({ id: "dave", role: "user" })) }));
vi.mock("@/lib/tenant-access", () => ({ currentTenantAccess: vi.fn(async () => ({ membershipRole: "member" })) }));
vi.mock("@/lib/project-context", () => ({ activeProjectIdFor: vi.fn(async () => "project-acme") }));
vi.mock("@/lib/lookups", () => ({
  getIssueTypes: vi.fn(async () => []),
  getPlatforms: vi.fn(async () => [
    { id: "cat-web", name: "Web", isActive: true },
    { id: "cat-mobile", name: "Mobile", isActive: true },
    { id: "cat-old", name: "Desktop", isActive: false },
  ]),
}));
vi.mock("@/lib/tenant-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-context")>()),
  currentTenantIdFor: vi.fn(async () => "tenant-acme"),
}));
vi.mock("@/lib/issue-stage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/issue-stage")>()),
  openIssueConfirmations: vi.fn(async () => new Map([["bug-1", { stage: "confirming", accepts: 1, rejects: 0, needed: 2, confirmed: false }]])),
}));
vi.mock("@/lib/voter-summaries", () => ({
  fetchVoterSummaries: vi.fn(async () =>
    new Map([
      [
        "bug-1",
        {
          likes: { count: 2, voters: [{ id: "a", name: "Ann", image: null }, { id: "b", name: "Ben", image: null }] },
          dislikes: { count: 1, voters: [{ id: "c", name: "Cy", image: null }] },
        },
      ],
    ]),
  ),
}));
vi.mock("@/lib/workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workflow")>()),
  workflowFor: vi.fn(async () => ({ ...(await import("@/lib/workflow-config")).DEFAULT_PROJECT_WORKFLOW, ideaThreshold: 4 })),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findFirst: vi.fn(async () => ({ slug: "acme-web", name: "Acme Web", goal: null })) },
    bug: { count, findMany, groupBy },
    idea: { count: ideaCount, findMany: ideaFindMany },
    ideaVerdict: { groupBy: ideaVerdictGroupBy },
    milestone: { findMany: vi.fn(async () => []) },
    projectArea: { findMany: vi.fn(async () => []) },
    user: { findUnique: vi.fn(async () => ({ keyboardShortcuts: true })) },
  },
}));

import BugsPage from "./page";
import { openIssueConfirmations } from "@/lib/issue-stage";
import { fetchVoterSummaries } from "@/lib/voter-summaries";

const BUG = {
  id: "bug-1",
  number: 7,
  title: "Login button does nothing",
  description: "## Summary\nLogin button does nothing\n\n## Acceptance Criteria\n- [ ] Fix login",
  createdByAgentId: null,
  status: "open",
  voteCount: 2,
  proofLinks: ["https://github.com/acme/web/pull/1", "https://github.com/acme/web/pull/2"],
  isDeleted: false,
  isBoosted: false,
  duplicateOf: null,
  createdAt: new Date("2026-10-01T10:00:00Z"),
  updatedAt: new Date("2026-10-20T10:00:00Z"),
  type: null,
  reporter: { name: "Rita Reporter", role: "user", image: null },
  assignee: { name: "Bob Builder", role: "user", image: null },
  category: { id: "cat-web", name: "Web" },
  area: null,
  votes: [],
  _count: { comments: 3, attachments: 1 },
};

const IDEA = {
  id: "idea-1",
  number: 12,
  title: "Export activity as CSV",
  score: 2,
  projectId: "project-acme",
  createdAt: new Date("2026-10-02T10:00:00Z"),
  reporter: { name: "Rita Reporter" },
  category: { name: "Web" },
  _count: { verdicts: 3 },
};

async function renderList(params: Record<string, string> = {}) {
  const page = (await BugsPage({ searchParams: Promise.resolve(params) })) as ReactElement;
  return renderToStaticMarkup(page);
}

const clean = (html: string) => html.replace(/<!-- -->/g, "");
/** The stage bar above the panel, and the status list down its left. */
const stages = (html: string) => clean(html).match(/<nav aria-label="Stages"[\s\S]*?<\/nav>/)?.[0] ?? "";
const statusList = (html: string) => clean(html).match(/<nav aria-label="Status"[\s\S]*?<\/nav>/)?.[0] ?? "";
const links = (nav: string) => [...nav.matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
const labelOf = (link: string) => link.match(/>([A-Za-z][A-Za-z ]*?)(?:<span|<\/a>)/)?.[1] ?? "";
const labels = (nav: string) => links(nav).map(labelOf);
const current = (nav: string) => links(nav).filter((link) => link.includes('aria-current="page"')).map(labelOf);
/** Each link's label and count: beside the label in the stage bar, read out after it in the status list. */
const counted = (nav: string) => Object.fromEntries(links(nav).map((link) => [labelOf(link), Number(link.match(/(\d+)<\/span>/)?.[1])]));

beforeEach(() => {
  vi.clearAllMocks();
  count.mockResolvedValue(1);
  findMany.mockResolvedValue([BUG]);
  ideaCount.mockResolvedValue(4);
  ideaFindMany.mockResolvedValue([IDEA]);
  ideaVerdictGroupBy.mockResolvedValue([]);
});

describe("issue list layout", () => {
  it("renders Issues as the page title with a page-level Add Idea CTA", async () => {
    const html = await renderList({ status: "all" });
    expect(html).toContain("Login button does nothing");
    expect(html).toMatch(/<h1[^>]*>Issues<\/h1>/);
    expect(html).toContain('href="/issues/new?from=%2Fissues"');
    expect(html).toContain("Add Idea");
  });

  it("keeps New issue on the empty filter state", async () => {
    // The search matches nothing, but the tracker itself isn't empty.
    count.mockImplementation(async (args: { where?: { OR?: unknown } }) => (args?.where?.OR ? 0 : 5));
    findMany.mockResolvedValue([]);
    const html = await renderList({ q: "nothing matches", status: "all" });
    expect(html).toContain("No issues match these filters.");
    expect(html).toContain('href="/issues/new?from=%2Fissues"');
  });

  it("welcomes a new, empty project even when the workspace has issues elsewhere", async () => {
    // Other projects in tenant-acme have 5 issues; project-acme has none.
    count.mockImplementation(async (args: { where?: { projectId?: unknown } }) =>
      args?.where?.projectId === "project-acme" ? 0 : 5,
    );
    findMany.mockResolvedValue([]);
    const html = await renderList({ status: "all" });
    expect(html).toContain("No issues yet");
    expect(html).not.toContain("No issues match these filters.");
    const firstRunCount = count.mock.calls.find(
      ([args]) =>
        args?.where?.isDeleted === false &&
        args?.where?.projectId === "project-acme" &&
        !args?.where?.status,
    );
    expect(firstRunCount?.[0].where).toMatchObject({ tenantId: "tenant-acme", projectId: "project-acme" });
  });

  it("does not call a workspace-wide empty filter a first run", async () => {
    // The active project is empty, but other projects in the workspace are not.
    // ?project=all must count those, or the page hides the filters.
    count.mockImplementation(async (args: { where?: { projectId?: unknown; OR?: unknown } }) => {
      if (args?.where?.OR) return 0;
      if (args?.where?.projectId) return 0;
      return 4;
    });
    findMany.mockResolvedValue([]);
    const html = await renderList({ project: "all", q: "nothing", status: "all" });
    expect(html).toContain("No issues match these filters.");
    expect(html).not.toContain("No issues yet");
    const firstRunCount = count.mock.calls.find(
      ([args]) => args?.where?.isDeleted === false && !args?.where?.OR && !args?.where?.status,
    );
    expect(firstRunCount?.[0].where.projectId).toBeUndefined();
  });

  it("names the tab when only a status tab is picked and it is empty, with no Clear filters link", async () => {
    count.mockImplementation(async (args: { where?: { status?: unknown } }) => (args?.where?.status === "requires_confirmation" ? 0 : 3));
    findMany.mockResolvedValue([]);
    const html = await renderList({ status: "requires_confirmation" });
    expect(html).toContain("No issues in Requires confirmation.");
    expect(html).not.toContain("No issues match these filters.");
    expect(html).not.toContain("Clear filters");
    expect(html).not.toContain("Try clearing filters");
  });

  it("says no issues match when the project has issues but the filters hide them", async () => {
    count.mockImplementation(async (args: { where?: { assigneeId?: unknown } }) => (args?.where?.assigneeId ? 0 : 3));
    findMany.mockResolvedValue([]);
    const html = await renderList({ mine: "assigned", status: "all" });
    expect(html).toContain("No issues match these filters.");
    expect(html).toContain('data-testid="whimsical-empty-state"');
    expect(html).toContain("Create a new issue");
    expect(html).toContain("Clear filters");
    expect(html).not.toContain("No issues yet");
  });

  it("lists ideas under Ideas' New ideas, from the Idea table, with their score and no importance button (#idea-table)", async () => {
    const html = await renderList();
    expect(ideaFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: "tenant-acme", projectId: "project-acme", status: "open", isDeleted: false }),
    }));
    expect(html).toContain('href="/ideas/12"');
    expect(html).toContain("Idea #12");
    expect(html).toContain('aria-label="Idea score 2 of 4"');
    expect(html).toContain("3 verdicts");
    expect(html).not.toMatch(/click to mark important/);
    // No issue row matches an idea list.
    expect(findMany.mock.calls.at(-1)![0].where.id).toEqual({ in: [] });
  });

  it("marks a bad idea red with Reject advised (#idea-rejected)", async () => {
    // Threshold 4: 1 good and 3 bad votes reach it, and bad outnumber good.
    ideaVerdictGroupBy.mockResolvedValue([
      { ideaId: "idea-1", opinion: "good", _sum: { votes: 1 } },
      { ideaId: "idea-1", opinion: "bad", _sum: { votes: 3 } },
    ]);
    const html = await renderList();
    expect(ideaVerdictGroupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { ideaId: { in: ["idea-1"] } } }));
    expect(html).toContain('aria-label="Idea score 2 of 4, reject advised"');
    expect(html).toMatch(/data-testid="idea-score-badge" data-tone="bad"/);
    expect(clean(html)).toContain("Reject advised");
  });

  it("does not mark an idea bad below the threshold", async () => {
    ideaVerdictGroupBy.mockResolvedValue([{ ideaId: "idea-1", opinion: "bad", _sum: { votes: 3 } }]);
    const html = await renderList();
    expect(html).toContain('aria-label="Idea score 2 of 4"');
    expect(clean(html)).not.toContain("Reject advised");
  });

  it("lists a person's ideas without the standard headings under Drafted", async () => {
    ideaFindMany.mockImplementation(async (args: { where: { createdByAgentId?: null; id?: { in: string[] } } }) =>
      args.where.createdByAgentId === null && !args.where.id
        ? [
            { id: "idea-1", description: "Make the export faster", createdByAgentId: null },
            { id: "idea-2", description: "## Summary\nx\n\n## Acceptance Criteria\n- y", createdByAgentId: null },
          ]
        : [IDEA]);
    const html = await renderList({ ideas: "drafts" });
    expect(ideaFindMany.mock.calls.at(-1)![0].where.id).toEqual({ in: ["idea-1"] });
    expect(html).toContain('href="/ideas/12"');
  });

  it("shows an issue's importance as a plain number in the Importance column, not a button", async () => {
    findMany.mockResolvedValue([{ ...BUG, projectId: "project-acme" }]);
    const html = await renderList({ status: "all" });
    expect(html).not.toContain('data-testid="idea-score-badge"');
    expect(html).not.toMatch(/click to mark important/);
    // The same CountBadge as the idea score and the confirmations.
    expect(html).toMatch(new RegExp(`data-testid="importance-count"[^>]*aria-label="Importance ${BUG.voteCount}"[^>]*><span>${BUG.voteCount}</span></span>`));
    expect(html).toContain('<span class="w-[76px] shrink-0 text-center">Importance</span>');
    expect(html).not.toContain(">Imp.</abbr>");
    // A number to read: no vote button, so no voters or the viewer's own votes are fetched.
    expect(html).not.toMatch(/<button[^>]*aria-label="[^"]*[Ii]mportan/);
    expect(fetchVoterSummaries).not.toHaveBeenCalled();
    expect(findMany.mock.calls.at(-1)![0].select).not.toHaveProperty("votes");
  });

  it("has no Priority column and no severity anywhere in the list", async () => {
    const html = await renderList({ status: "all" });
    expect(html).not.toContain("Priority");
    expect(html).not.toContain("issues-priority");
    expect(html).not.toMatch(/severity|Most severe/i);
    expect(findMany.mock.calls.at(-1)![0].select).not.toHaveProperty("severity");
  });

  it("has no bulk-select checkboxes", async () => {
    const html = await renderList({ status: "all" });
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("issues-selection");
  });

  it("has no stage sidebar beside the list (#1054)", async () => {
    const html = await renderList();
    expect(html).not.toContain('aria-label="Issue stages"');
    expect(html).not.toContain("lg:w-56");
  });

  it("still filters by ?stage= from old links (#1054)", async () => {
    await renderList({ stage: "confirming", status: "all" });
    const listQuery = findMany.mock.calls.at(-1)![0];
    expect(listQuery.where.id).toEqual({ in: ["bug-1"] });
  });

  it("counts platform-tab badges and the Show-N-resolved link inside the stage filter (#626)", async () => {
    await renderList({ stage: "confirming", status: "all" });

    // The platform tabs group off the post-stage snapshot: their where-clause
    // must carry the stage's row ids. (The status-tabs groupBy drops them on
    // purpose, so assert existence, not exclusivity.)
    const stagedGroupBy = groupBy.mock.calls.filter(
      ([args]) => Array.isArray((args?.where as { id?: { in?: unknown[] } })?.id?.in),
    );
    expect(stagedGroupBy.length).toBeGreaterThan(0);
    // The footer's "Show N resolved" link is gone (the Resolved tab covers it),
    // so its staged count query is no longer made.
  });

  it("is one centred list column without the stats card (#1056)", async () => {
    const html = await renderList();
    expect(html).not.toContain("Total issues");
    expect(html).toContain('<div class="issues-page mx-auto w-full max-w-6xl space-y-5">');
    // The four stats counts are no longer queried.
    const statusOnly = count.mock.calls.filter(([args]) => args?.where?.status === "in_progress");
    expect(statusOnly).toHaveLength(0);
  });
  it("keeps search and scope when switching status, and resets paging and intake", async () => {
    const html = await renderList({ q: "login", platform: "cat-web", mine: "assigned", stage: "reported", page: "2", status: "open" });
    const list = statusList(html);
    expect(list).toContain('href="/issues?q=login&amp;platform=cat-web&amp;mine=assigned&amp;status=in_progress"');
    expect(list).not.toContain("page=");
    expect(list).not.toContain("stage=");
    const statusCount = groupBy.mock.calls.find(([args]) => args?.by?.[0] === "status");
    expect(statusCount?.[0].where).toMatchObject({ tenantId: "tenant-acme", projectId: "project-acme", categoryId: "cat-web" });
    expect(statusCount?.[0].where).not.toHaveProperty("status");
  });
  it("puts the platforms behind an icon beside the notes, above the panel, with counts (#1055)", async () => {
    groupBy.mockResolvedValue([
      { categoryId: "cat-web", _count: { _all: 4 } },
      { categoryId: "cat-mobile", _count: { _all: 2 } },
      { categoryId: null, _count: { _all: 1 } },
    ] as never);
    const html = await renderList({ platform: "cat-web", page: "2", q: "login" });

    // It sits in the stage row, with Project notes, not in the panel.
    const row = html.slice(0, html.indexOf('<div class="issues-page'));
    expect(row).toContain('aria-label="Project notes"');
    expect(row).toMatch(/<nav [^>]*aria-label="Platforms"/);
    // An icon named for the chosen platform; the list stays hidden until opened.
    expect(row).toContain('aria-label="Platform: Web"');
    expect(row).not.toContain("Platform: <span");
    const nav = row.match(/<nav [^>]*aria-label="Platforms"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(nav).toMatch(/<nav [^>]*aria-label="Platforms" hidden=""/);
    const tabs = [...nav.matchAll(/<a [^>]*><span[^>]*>([^<]+)<\/span><span[^>]*>(\d+)<\/span><\/a>/g)].map((m) => `${m[1].trim()} ${m[2]}`);
    // Active platforms only (not the inactive Desktop).
    expect(tabs).toEqual(["All 7", "Web 4", "Mobile 2", "No platform 1"]);
    expect(nav).toMatch(/aria-current="page"[^>]*href="\/issues\?q=login&amp;platform=cat-web"/);
    // Choosing a platform keeps the search, drops paging, and swaps the platform.
    expect(nav).toContain('href="/issues?q=login&amp;platform=cat-mobile"');
    expect(nav).toContain('href="/issues?q=login"');
    expect(nav).toContain('href="/issues?q=login&amp;platform=none"');

    // The counts ignore the current platform, so every choice is honest.
    const tabQuery = groupBy.mock.calls.find(([args]) => args.by[0] === "categoryId")![0];
    expect(tabQuery.where).not.toHaveProperty("categoryId");
    // The list itself is still narrowed to the chosen platform.
    expect(findMany.mock.calls.at(-1)![0].where.categoryId).toBe("cat-web");
  });
  it("keeps the Live status when a platform is chosen (#473)", async () => {
    groupBy.mockResolvedValue([
      { categoryId: "cat-web", _count: { _all: 4 } },
      { categoryId: "cat-mobile", _count: { _all: 2 } },
    ] as never);
    const html = await renderList({ status: "resolved" });
    expect(current(statusList(html))).toEqual(["Live"]);
    const nav = html.match(/<nav [^>]*aria-label="Platforms"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(nav).toContain('href="/issues?status=resolved"');
    expect(nav).toContain('href="/issues?status=resolved&amp;platform=cat-web"');
  });
  it("counts every issue in the platform menu on Ideas, and a pick opens the All tab", async () => {
    groupBy.mockResolvedValue([
      { categoryId: "cat-web", _count: { _all: 4 } },
      { categoryId: "cat-mobile", _count: { _all: 2 } },
    ] as never);
    const html = await renderList({ ideas: "drafts" });
    const tabQuery = groupBy.mock.calls.find(([args]) => args.by[0] === "categoryId")![0];
    expect(tabQuery.where).not.toHaveProperty("id");
    expect(tabQuery.where).not.toHaveProperty("status");
    const nav = html.match(/<nav [^>]*aria-label="Platforms"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(nav).toContain('href="/issues?status=all&amp;platform=cat-web"');
    expect(nav).toContain('href="/issues?status=all"');
    expect(nav).not.toContain("ideas=");
  });

  it("counts each platform's total in the platform menu, whatever status tab is picked", async () => {
    for (const status of ["open", "in_progress", "done", "ready_to_merge", "resolved", "all"]) {
      groupBy.mockClear();
      await renderList({ status, mine: "assigned" });
      const tabQuery = groupBy.mock.calls.find(([args]) => args.by[0] === "categoryId")![0];
      for (const key of ["status", "AND", "categoryId"]) expect(tabQuery.where).not.toHaveProperty(key);
      // Other filters still narrow it.
      expect(tabQuery.where?.assigneeId).toBe("dave");
    }
  });

  it("keeps the picked tab's status out of the tab counts", async () => {
    for (const status of ["done", "ready_to_merge", "resolved"]) {
      groupBy.mockClear();
      await renderList({ status });
      const statusCount = groupBy.mock.calls.find(([args]) => args?.by?.[0] === "status")![0];
      expect(statusCount.where).not.toHaveProperty("status");
    }
  });

  it("shows the three stages above the panel, Ideas picked, and lists New ideas and Rejected ideas on the left", async () => {
    const html = await renderList();
    expect(labels(stages(html))).toEqual(["Ideas", "Working", "Delivered"]);
    expect(current(stages(html))).toEqual(["Ideas"]);
    expect(stages(html)).toContain('href="/issues"');
    expect(stages(html)).toContain('href="/issues?status=requires_confirmation"');
    expect(stages(html)).toContain('href="/issues?status=delivered"');
    expect(labels(statusList(html))).toEqual(["New ideas", "Rejected ideas"]);
    expect(current(statusList(html))).toEqual(["New ideas"]);
    expect(html.indexOf('aria-label="Stages"')).toBeLessThan(html.indexOf('<div class="issues-page'));
  });

  it("puts Requires confirmation, Open, In progress and Closed under Working, and Delivered, Done, Ready to merge and Live under Delivered", async () => {
    let html = await renderList({ status: "in_progress" });
    expect(current(stages(html))).toEqual(["Working"]);
    expect(labels(statusList(html))).toEqual(["Requires confirmation", "Open", "In progress", "Closed"]);
    expect(current(statusList(html))).toEqual(["In progress"]);

    html = await renderList({ status: "ready_to_merge" });
    expect(current(stages(html))).toEqual(["Delivered"]);
    expect(labels(statusList(html))).toEqual(["Delivered", "Done", "Ready to merge", "Live"]);
    expect(current(statusList(html))).toEqual(["Ready to merge"]);
  });
  it("lists issues that require confirmation on their own tab (#requires-confirmation)", async () => {
    await renderList({ status: "requires_confirmation" });
    expect(findMany.mock.calls.at(-1)![0].where.status).toBe("requires_confirmation");
  });

  it("counts confirmations on the left on the Requires confirmation tab, and puts importance at the row end", async () => {
    const html = await renderList({ status: "requires_confirmation" });
    expect(html).toContain('title="Confirmations">Conf.</abbr>');
    expect(html).toContain('<span class="issues-vote-end">Importance</span>');
    expect(html).not.toContain("Priority");
    expect(html).toContain('aria-label="1 of 2 confirmations so far"');
    // Just the count: no "of 2" and no check while it is not confirmed.
    expect(html).toMatch(/data-testid="confirmation-count"[^>]*><span[^>]*>1<\/span><\/span>/);
    expect(html).not.toMatch(/data-testid="confirmation-count"[\s\S]*?>of 2</);
    expect(clean(html)).toContain("Not confirmed");
    expect(html).not.toContain("Requires confirmation…");
    // The importance number comes after the status cell, at the end of the row.
    const row = html.slice(html.indexOf('class="issues-row'));
    expect(row.indexOf("issues-vote issues-vote-end")).toBeGreaterThan(row.indexOf("issues-status-cell"));
    expect(row).toMatch(/issues-vote issues-vote-end[^>]*><span data-testid="importance-count"/);
    expect(row).not.toContain('class="issues-vote w-[76px]');
  });

  it("turns the confirmations badge green with a check, and the row says Confirmed, at the threshold", async () => {
    vi.mocked(openIssueConfirmations).mockResolvedValueOnce(new Map([["bug-1", { stage: "confirming", accepts: 2, rejects: 0, needed: 2, confirmed: true }]]));
    const html = await renderList({ status: "requires_confirmation" });
    expect(html).toContain('aria-label="Confirmed: 2 of 2 confirmations"');
    expect(html).toMatch(/data-testid="confirmation-count"[^>]*bg-zk-ok-bg[^>]*><span[^>]*>2<\/span><span[^>]*><svg/);
    expect(clean(html)).toMatch(/class="issue-row-status[^"]*text-zk-ok-fg"[^>]*>[\s\S]*?Confirmed<\/span>/);
    expect(clean(html)).not.toContain("Not confirmed");
  });

  it("keeps importance on the left, with no Priority column, on the other tabs", async () => {
    const html = await renderList({ status: "open" });
    expect(html).toContain('<span class="w-[76px] shrink-0 text-center">Importance</span>');
    expect(html).not.toContain(">Imp.</abbr>");
    expect(html).not.toContain("Priority");
    expect(html).not.toContain("issues-vote-end");
    expect(html).not.toContain("confirmation-count");
  });

  it("has no status toolbar, filter rows, breadcrumb, merge history or deleted-issues link", async () => {
    const html = await renderList();
    for (const gone of ['aria-label="Issue status"', 'aria-label="Filter ideas"', 'aria-label="Filter all issues"', 'aria-label="Breadcrumb"', "Merge history", "View deleted issues", "Sort issues"]) {
      expect(html).not.toContain(gone);
    }
    expect(html).toContain('<h1 class="sr-only">Issues</h1>');
  });
  it("drops ?ideas= when moving to another stage", async () => {
    const html = await renderList({ ideas: "drafts" });
    expect(stages(html)).toContain('href="/issues?status=requires_confirmation"');
    expect(stages(html)).not.toContain("ideas=");
  });
  it("leaves Ideas unselected on the other stages", async () => {
    const html = await renderList({ status: "open" });
    expect(current(stages(html))).toEqual(["Working"]);
    expect(labels(statusList(html))).not.toContain("Ideas");
  });
  it("shows no tabs when the project has no platforms to choose between (#1055)", async () => {
    groupBy.mockResolvedValue([] as never);
    const { getPlatforms } = await import("@/lib/lookups");
    vi.mocked(getPlatforms).mockResolvedValueOnce([]);
    const html = await renderList();
    expect(html).not.toContain('aria-label="Platforms"');
  });

  it("lands on Ideas; All (?status=all) shows every issue, finished ones too, with no stage picked", async () => {
    let html = await renderList();
    expect(current(stages(html))).toEqual(["Ideas"]);
    expect(findMany.mock.calls.at(-1)![0].where.id).toEqual({ in: [] });

    html = await renderList({ q: "login", status: "all" });
    expect(findMany.mock.calls.at(-1)![0].where).not.toHaveProperty("status");
    expect(current(stages(html))).toEqual([]);
    expect(stages(html)).toContain('href="/issues?q=login&amp;status=delivered"');
    expect(html).not.toContain('aria-label="Status"');
  });
  it("searches across All when no stage is picked, so a just-reported issue can be found", async () => {
    const html = await renderList({ q: "login" });
    const where = findMany.mock.calls.at(-1)![0].where;
    expect(where).not.toHaveProperty("id");
    expect(where).not.toHaveProperty("status");
    expect(current(stages(html))).toEqual([]);
  });
  it("shows a Filter by row under All: All, Rejected and Duplicates (Closed has its own tab)", async () => {
    const html = await renderList({ status: "all" });
    const filters = html.match(/<nav aria-label="Filter all issues"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(filters).toContain("Filter by:");
    const labels = [...filters.matchAll(/<a [^>]*>([A-Za-z]+)<span/g)].map((m) => m[1]);
    expect(labels).toEqual(["All", "Rejected", "Duplicates"]);
    expect(filters).toContain('href="/issues?status=rejected"');
    expect(filters).toContain('href="/issues?status=duplicate"');
  });

  it("keeps All selected on its filters and narrows the list: Rejected by a confirmation entry, Duplicates by duplicateOf", async () => {
    let html = await renderList({ status: "rejected" });
    expect(findMany.mock.calls.at(-1)![0].where.confirmations).toEqual({ some: { verdict: "reject", undoneAt: null } });
    expect(findMany.mock.calls.at(-1)![0].where).not.toHaveProperty("status");
    expect(html).toMatch(/aria-current="page"[^>]*href="\/issues\?status=rejected"|href="\/issues\?status=rejected"[^>]*aria-current="page"/);

    html = await renderList({ status: "duplicate" });
    expect(findMany.mock.calls.at(-1)![0].where.duplicateOfId).toEqual({ not: null });
    expect(html).toContain('aria-label="Filter all issues"');
  });

  it("keeps the hidden duplicates out of tab counts, even on the Duplicates filter", async () => {
    await renderList({ status: "duplicate" });
    const statusCount = groupBy.mock.calls.find(([args]) => args?.by?.[0] === "status");
    expect(statusCount?.[0]?.where?.duplicateOfId).toBeNull();
    const duplicateCount = count.mock.calls.find(([args]) => (args?.where?.duplicateOfId as { not?: unknown } | undefined)?.not === null);
    expect(duplicateCount).toBeTruthy();
  });

  it("hides the Filter by row on Open, In progress and Done", async () => {
    for (const status of ["open", "in_progress", "resolved"]) {
      expect(await renderList({ status })).not.toContain('aria-label="Filter all issues"');
    }
  });

  it("still shows everything with ?resolved=1, without a footer toggle (#1058)", async () => {
    const html = await renderList({ resolved: "1" });
    expect(findMany.mock.calls.at(-1)![0].where).not.toHaveProperty("status");
    expect(html).not.toContain("Hide resolved");
  });

  it("lets an explicit status filter win over the default (#1058)", async () => {
    const html = await renderList({ status: "open" });
    expect(findMany.mock.calls.at(-1)![0].where.status).toBe("open");
    expect(html).not.toContain("Show 0 resolved");
    expect(html).not.toContain("Hide resolved");
  });

  it("lists each tab by the one status: Done is status done (Ziki #713)", async () => {
    for (const status of ["in_progress", "done", "ready_to_merge", "resolved"]) {
      await renderList({ status });
      const where = findMany.mock.calls.at(-1)![0].where;
      expect(where.status).toBe(status);
      expect(where).not.toHaveProperty("AND");
    }
  });

  it("counts each stage as its statuses added up, and each status on the left by itself", async () => {
    groupBy.mockImplementation((async (args: { by: string[] }) =>
      args.by[0] !== "status"
        ? []
        : [
          { status: "requires_confirmation", _count: { _all: 4 } },
          { status: "open", _count: { _all: 9 } },
          { status: "in_progress", _count: { _all: 2 } },
          { status: "delivered", _count: { _all: 5 } },
          { status: "done", _count: { _all: 2 } },
          { status: "ready_to_merge", _count: { _all: 1 } },
          { status: "resolved", _count: { _all: 7 } },
          { status: "closed", _count: { _all: 3 } },
        ]) as never);
    const html = await renderList({ status: "open" });
    // Ideas: new ideas + rejected ideas. Working: Requires confirmation, Open, In progress, Closed. Delivered: Delivered, Done, Ready to merge, Live.
    expect(counted(stages(html))).toEqual({ Ideas: 8, Working: 18, Delivered: 15 });
    expect(counted(statusList(html))).toEqual({ "Requires confirmation": 4, Open: 9, "In progress": 2, Closed: 3 });
  });
  it("shows the vote count once and no proof-link count in rows (#1060)", async () => {
    const html = await renderList({ status: "all" });
    expect(html).not.toContain("🔗");
    expect(html).not.toContain("linked proof");
    expect(html).not.toContain("👍");
    expect(html).not.toContain("👎");
    // The voters' faces aren't repeated under the row.
    expect(html).not.toContain(">Ann<");
    expect(findMany.mock.calls.at(-1)![0].select).not.toHaveProperty("proofLinks");
  });

  it("shows the assignee as a face only, and a short updated date (#1061)", async () => {
    const html = await renderList({ status: "all" });
    // The name is only in the tooltip and for screen readers.
    expect(html).toContain('title="Assigned to Bob Builder"');
    expect(html).toContain('<span class="sr-only">Assigned to Bob Builder</span>');
    expect(html).not.toContain("max-w-[10rem] truncate");
    // "Updated" means updatedAt (Oct 20), not when it was opened (Oct 1).
    expect(html).toMatch(/<time dateTime="2026-10-20T10:00:00.000Z" title="Updated Oct 20, 2026/);
    expect(html).not.toContain(">updated<");
  });

  it("dates rows by when they were opened when sorted by newest (#1061)", async () => {
    const html = await renderList({ sort: "newest", status: "all" });
    expect(html).toMatch(/<time dateTime="2026-10-01T10:00:00.000Z" title="Opened /);
  });

  it("keeps the row unwatch action visible in the compact mobile layout", async () => {
    const html = await renderList({ mine: "watching", status: "all" });

    expect(html).toContain('class="w-10 shrink-0 items-center justify-end gap-2 flex"');
    expect(html).toMatch(/aria-label="Unwatch [^"]*Login button does nothing"/);
  });
});
