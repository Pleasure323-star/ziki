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
  openIssueConfirmations: vi.fn(async () => new Map([["bug-1", { stage: "confirming", accepts: 1, rejects: 0, needed: 2 }]])),
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
    milestone: { findMany: vi.fn(async () => []) },
    projectArea: { findMany: vi.fn(async () => []) },
    user: { findUnique: vi.fn(async () => ({ keyboardShortcuts: true })) },
  },
}));

import BugsPage from "./page";

const BUG = {
  id: "bug-1",
  number: 7,
  title: "Login button does nothing",
  description: "## Summary\nLogin button does nothing\n\n## Acceptance Criteria\n- [ ] Fix login",
  createdByAgentId: null,
  status: "open",
  severity: "high",
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

beforeEach(() => {
  vi.clearAllMocks();
  count.mockResolvedValue(1);
  findMany.mockResolvedValue([BUG]);
  ideaCount.mockResolvedValue(4);
  ideaFindMany.mockResolvedValue([IDEA]);
});

describe("issue list layout", () => {
  it("renders Issues as the page title with a page-level New issue CTA", async () => {
    const html = await renderList({ status: "all" });
    expect(html).toContain("Login button does nothing");
    expect(html).toMatch(/<h1[^>]*>Issues<\/h1>/);
    expect(html).toContain('href="/issues/new?from=%2Fissues"');
    expect(html).toContain("New issue");
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

  it("says no issues match when the project has issues but the filters hide them", async () => {
    count.mockImplementation(async (args: { where?: { severity?: unknown } }) => (args?.where?.severity ? 0 : 3));
    findMany.mockResolvedValue([]);
    const html = await renderList({ severity: "critical", status: "all" });
    expect(html).toContain("No issues match these filters.");
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
    const filters = html.match(/<nav aria-label="Filter ideas"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(filters).toMatch(/aria-current="page"[^>]*>Drafted<span[^>]*>1<\/span>/);
  });

  it("keeps the importance button on an issue, with an Importance column", async () => {
    findMany.mockResolvedValue([{ ...BUG, projectId: "project-acme" }]);
    const html = await renderList({ status: "all" });
    expect(html).not.toContain('data-testid="idea-score-badge"');
    expect(html).toMatch(/click to mark important/);
    expect(html).toContain('title="Importance"');
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
    expect(html).toMatch(/^<div class="issues-page mx-auto w-full max-w-6xl space-y-5">/);
    // The four stats counts are no longer queried.
    const statusOnly = count.mock.calls.filter(([args]) => args?.where?.status === "in_progress");
    expect(statusOnly).toHaveLength(0);
  });

  it("keeps search and scope when switching status, and resets paging and intake", async () => {
    const html = await renderList({ q: "login", platform: "cat-web", mine: "assigned", stage: "reported", page: "2" });
    const nav = html.match(/<nav aria-label="Issue status"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(nav).toContain('href="/issues?q=login&amp;platform=cat-web&amp;mine=assigned&amp;status=in_progress"');
    expect(nav).not.toContain("page=");
    expect(nav).not.toContain("stage=");
    const statusCount = groupBy.mock.calls.find(([args]) => args?.by?.[0] === "status");
    expect(statusCount?.[0].where).toMatchObject({ tenantId: "tenant-acme", projectId: "project-acme", categoryId: "cat-web" });
    expect(statusCount?.[0].where).not.toHaveProperty("status");
  });

  it("puts the platforms in a dropdown in the search/filter/sort row, with counts (#1055)", async () => {
    groupBy.mockResolvedValue([
      { categoryId: "cat-web", _count: { _all: 4 } },
      { categoryId: "cat-mobile", _count: { _all: 2 } },
      { categoryId: null, _count: { _all: 1 } },
    ] as never);
    const html = await renderList({ platform: "cat-web", page: "2", q: "login" });

    // It sits with the other heading controls, not in the status tab row.
    const heading = html.match(/<div class="issues-heading[\s\S]*?<div class="issues-tabs-row/)?.[0] ?? "";
    expect(heading).toMatch(/<nav [^>]*aria-label="Platforms"/);
    const tabsRow = html.match(/<div class="issues-tabs-row[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(tabsRow).toContain('aria-label="Issue status"');
    expect(tabsRow).not.toContain('aria-label="Platforms"');
    // The trigger names the chosen platform; the list stays hidden until opened.
    expect(heading).toMatch(/Platform: <span[^>]*>Web<\/span>/);
    const nav = heading.match(/<nav [^>]*aria-label="Platforms"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(nav).toMatch(/<nav [^>]*aria-label="Platforms" hidden=""/);
    const tabs = [...nav.matchAll(/<a [^>]*><span[^>]*>([^<]+)<\/span><span[^>]*>(\d+)<\/span><\/a>/g)].map((m) => `${m[1].trim()} ${m[2]}`);
    // Active platforms only (not the inactive Desktop); no Resolved entry, the status tabs have it.
    expect(tabs).toEqual(["All 7", "Web 4", "Mobile 2", "No platform 1"]);
    expect(nav).toMatch(/aria-current="page"[^>]*href="\/issues\?q=login&amp;platform=cat-web"/);
    // Choosing a platform keeps the search, drops paging, and swaps the platform.
    expect(nav).toContain('href="/issues?q=login&amp;platform=cat-mobile"');
    expect(nav).toContain('href="/issues?q=login"');
    expect(nav).toContain('href="/issues?q=login&amp;platform=none"');
    expect(html).not.toContain('aria-label="Platforms" class="w-full');

    // The counts ignore the current platform, so every tab is honest.
    const tabQuery = groupBy.mock.calls.find(([args]) => args.by[0] === "categoryId")![0];
    expect(tabQuery.where).not.toHaveProperty("categoryId");
    // The list itself is still narrowed to the chosen platform.
    expect(findMany.mock.calls.at(-1)![0].where.categoryId).toBe("cat-web");
  });

  it("keeps the Resolved status when a platform is chosen (#473)", async () => {
    groupBy.mockResolvedValue([
      { categoryId: "cat-web", _count: { _all: 4 } },
      { categoryId: "cat-mobile", _count: { _all: 2 } },
    ] as never);
    const html = await renderList({ status: "resolved" });
    const status = html.match(/<nav aria-label="Issue status"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(status).toMatch(/aria-current="page" href="\/issues\?status=resolved"/);
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
      await renderList({ status, severity: "high" });
      const tabQuery = groupBy.mock.calls.find(([args]) => args.by[0] === "categoryId")![0];
      for (const key of ["status", "AND", "categoryId"]) expect(tabQuery.where).not.toHaveProperty(key);
      // Other filters still narrow it.
      expect(tabQuery.where?.severity).toBe("high");
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

  it("puts Ideas first in one left-aligned bar, with the open ideas' count, then Requires confirmation before Open", async () => {
    const html = await renderList();
    const nav = html.match(/<nav aria-label="Issue status"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(nav).toMatch(/class="issues-status-nav min-w-0"/);
    expect(nav).not.toContain("ml-auto");
    const labels = [...nav.matchAll(/<span class="issues-status-label">([A-Za-z ]+)<\/span><span class="issues-status-count">/g)].map((m) => m[1]);
    expect(labels).toEqual(["Ideas", "Requires confirmation", "Open", "In progress", "Done", "Ready to merge", "Live", "Closed", "All"]);
    const ideas = nav.match(/<a [^>]*data-testid="ideas-tab"[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(ideas).toMatch(/href="\/issues"/);
    expect(ideas).toContain('aria-current="page"');
    expect(ideas).toContain("issues-status-ideas");
    expect(ideas).toContain('<span class="issues-status-count">4</span>');
  });

  it("lists issues that require confirmation on their own tab (#requires-confirmation)", async () => {
    await renderList({ status: "requires_confirmation" });
    expect(findMany.mock.calls.at(-1)![0].where.status).toBe("requires_confirmation");
  });

  it("filters Ideas with small pills, New ideas and Drafted, and nothing else above the list", async () => {
    const html = await renderList();
    const filters = html.match(/<nav aria-label="Filter ideas"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(filters).toContain("Filter by:");
    const labels = [...filters.matchAll(/<a [^>]*>([A-Za-z ]+)<span/g)].map((m) => m[1]);
    expect(labels).toEqual(["New ideas", "Drafted"]);
    expect(filters).toMatch(/aria-current="page"[^>]*>New ideas/);
    expect(filters).toContain('href="/issues?ideas=drafts"');
    for (const gone of ["How the Inbox works", "Your agents", "Need your input", "Design feedback needed", 'aria-label="Filter all issues"']) {
      expect(html).not.toContain(gone);
    }
  });

  it("drops the Ideas filter when moving to another tab", async () => {
    const html = await renderList({ ideas: "drafts" });
    const status = html.match(/<nav aria-label="Issue status"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(status).toContain('href="/issues?status=open"');
    expect(status).not.toContain("ideas=");
  });

  it("leaves Ideas unselected on the other tabs, with no Ideas filters", async () => {
    const html = await renderList({ status: "open" });
    const ideas = html.match(/<a [^>]*data-testid="ideas-tab"[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(ideas).toContain("Ideas");
    expect(ideas).not.toContain('aria-current="page"');
    expect(html).not.toContain('aria-label="Filter ideas"');
  });

  it("shows no tabs when the project has no platforms to choose between (#1055)", async () => {
    groupBy.mockResolvedValue([] as never);
    const { getPlatforms } = await import("@/lib/lookups");
    vi.mocked(getPlatforms).mockResolvedValueOnce([]);
    const html = await renderList();
    expect(html).not.toContain('aria-label="Platforms"');
  });

  it("lands on Ideas; All (?status=all) shows every issue, finished ones too", async () => {
    let html = await renderList();
    expect(html).toContain('aria-label="Filter ideas"');
    expect(findMany.mock.calls.at(-1)![0].where.id).toEqual({ in: [] });

    html = await renderList({ q: "login", status: "all" });
    expect(findMany.mock.calls.at(-1)![0].where).not.toHaveProperty("status");
    const status = html.match(/<nav aria-label="Issue status"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(status).toContain('href="/issues?q=login&amp;status=resolved"');
    expect(status).toMatch(/aria-current="page" href="\/issues\?q=login&amp;status=all"/);
  });

  it("searches across All when no tab is picked, so a just-reported issue can be found", async () => {
    const html = await renderList({ q: "login" });
    const where = findMany.mock.calls.at(-1)![0].where;
    expect(where).not.toHaveProperty("id");
    expect(where).not.toHaveProperty("status");
    const status = html.match(/<nav aria-label="Issue status"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(status).toMatch(/aria-current="page" href="\/issues\?q=login&amp;status=all"/);
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
    const status = html.match(/<nav aria-label="Issue status"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(status).toMatch(/aria-current="page" href="\/issues\?status=all"/);
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

  it("gives every status its own tab, counted by status, and All adds them up", async () => {
    groupBy.mockImplementation((async (args: { by: string[] }) =>
      args.by[0] !== "status"
        ? []
        : [
          { status: "requires_confirmation", _count: { _all: 4 } },
          { status: "open", _count: { _all: 9 } },
          { status: "in_progress", _count: { _all: 2 } },
          { status: "done", _count: { _all: 2 } },
          { status: "ready_to_merge", _count: { _all: 1 } },
          { status: "resolved", _count: { _all: 7 } },
          { status: "closed", _count: { _all: 3 } },
        ]) as never);
    const html = await renderList({ status: "all" });
    const nav = html.match(/<nav aria-label="Issue status"[\s\S]*?<\/nav>/)?.[0] ?? "";
    const counts = Object.fromEntries(
      [...nav.matchAll(/<span class="issues-status-label">([A-Za-z ]+)<\/span><span class="issues-status-count">(\d+)<\/span>/g)].map((m) => [m[1], Number(m[2])]),
    );
    expect(counts).toEqual({ Ideas: 4, "Requires confirmation": 4, Open: 9, "In progress": 2, Done: 2, "Ready to merge": 1, Live: 7, Closed: 3, All: 28 });
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
