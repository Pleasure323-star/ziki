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
  openIssueStages: vi.fn(async () => new Map([["bug-1", "confirming"]])),
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
const ownAgents = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const workDone = vi.hoisted(() => vi.fn(async () => new Map()));
vi.mock("@/lib/dashboard-overview", () => ({ loadOwnAgents: ownAgents }));
vi.mock("@/lib/agent-work", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-work")>()),
  agentWorkDone: workDone,
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
    const html = await renderList();
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
    const html = await renderList();
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

  it("lists ideas on their own tab, from the Idea table, with their score and no upvote button (#idea-table)", async () => {
    const html = await renderList({ status: "ideas" });
    expect(ideaFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: "tenant-acme", projectId: "project-acme", status: "open", isDeleted: false }),
    }));
    expect(html).toContain('href="/ideas/12"');
    expect(html).toContain("Idea #12");
    expect(html).toContain('aria-label="Idea score 2 of 4"');
    expect(html).toContain("3 verdicts");
    expect(html).not.toMatch(/click to upvote/);
    // No issue row matches the Ideas tab.
    expect(findMany.mock.calls.at(-1)![0].where.id).toEqual({ in: [] });
  });

  it("keeps the upvote button on an issue", async () => {
    findMany.mockResolvedValue([{ ...BUG, projectId: "project-acme" }]);
    const html = await renderList();
    expect(html).not.toContain('data-testid="idea-score-badge"');
    expect(html).toMatch(/click to upvote/);
  });

  it("has no stage sidebar beside the list (#1054)", async () => {
    const html = await renderList();
    expect(html).not.toContain('aria-label="Issue stages"');
    expect(html).not.toContain("lg:w-56");
  });

  it("still filters by ?stage= from old links (#1054)", async () => {
    await renderList({ stage: "confirming" });
    const listQuery = findMany.mock.calls.at(-1)![0];
    expect(listQuery.where.id).toEqual({ in: ["bug-1"] });
  });

  it("counts platform-tab badges and the Show-N-resolved link inside the stage filter (#626)", async () => {
    await renderList({ stage: "confirming" });

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
    const tabsRow = html.match(/<div class="issues-tabs-row[\s\S]*?<\/nav><\/div>/)?.[0] ?? "";
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

  it("counts every issue in the platform menu on the Inbox, and a pick opens the All tab", async () => {
    groupBy.mockResolvedValue([
      { categoryId: "cat-web", _count: { _all: 4 } },
      { categoryId: "cat-mobile", _count: { _all: 2 } },
    ] as never);
    const html = await renderList({ inbox: "design" });
    const tabQuery = groupBy.mock.calls.find(([args]) => args.by[0] === "categoryId")![0];
    expect(tabQuery.where).not.toHaveProperty("agentQuestions");
    expect(tabQuery.where).not.toHaveProperty("redesigns");
    expect(tabQuery.where).not.toHaveProperty("status");
    const nav = html.match(/<nav [^>]*aria-label="Platforms"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(nav).toContain('href="/issues?status=all&amp;platform=cat-web"');
    expect(nav).toContain('href="/issues?status=all"');
    expect(nav).not.toContain("inbox=");
  });

  it("counts each platform's total in the platform menu, whatever status tab is picked", async () => {
    for (const status of ["open", "in_progress", "resolved", "ready_to_merge", "auto_merge", "all"]) {
      groupBy.mockClear();
      await renderList({ status, severity: "high" });
      const tabQuery = groupBy.mock.calls.find(([args]) => args.by[0] === "categoryId")![0];
      for (const key of ["status", "reviewStatus", "AND", "categoryId"]) expect(tabQuery.where).not.toHaveProperty(key);
      // Other filters still narrow it.
      expect(tabQuery.where?.severity).toBe("high");
    }
  });

  it("keeps the Ready to Merge and Live clauses out of the other tabs' counts", async () => {
    for (const status of ["ready_to_merge", "auto_merge"]) {
      groupBy.mockClear();
      await renderList({ status });
      const statusCount = groupBy.mock.calls.find(([args]) => args?.by?.[0] === "status")![0];
      expect(statusCount.where).not.toHaveProperty("reviewStatus");
      expect(statusCount.where).not.toHaveProperty("status");
    }
  });

  it("puts Inbox at the left of the tab row: it lists the escalated issues, like a tab, with the tabs on the right", async () => {
    count.mockResolvedValue(2 as never);
    const html = await renderList({ status: "escalated" });
    const row = html.match(/<div class="issues-tabs-row[\s\S]*?<\/nav>/)?.[0] ?? "";
    const status = row.slice(row.indexOf('<nav aria-label="Issue status"'));
    const labels = [...status.matchAll(/<\/span>([A-Za-z ]+)<span class="issues-status-count">/g)].map((m) => m[1]);
    expect(labels).toEqual(["Ideas", "Open", "In progress", "Done", "Ready to Merge", "Live", "All"]);
    expect(row).toMatch(/class="issues-status-nav ml-auto/);
    const inbox = row.slice(0, row.indexOf('<nav aria-label="Issue status"'));
    expect(inbox).toMatch(/<a [^>]*href="\/issues"/);
    expect(inbox).toContain('aria-current="page"');
    expect(inbox).toMatch(/Inbox<span[^>]*>2<\/span>/);
    // Still red while selected, since issues are waiting.
    expect(inbox).toMatch(/<span class="[^"]*bg-zk-bad-bg[^"]*">2<\/span>/);
    expect(findMany.mock.calls.at(-1)![0].where.agentQuestions).toEqual({ some: { answeredAt: null } });
  });

  it("opens the Inbox with how it works, then its lists: Need your input, Design feedback needed", async () => {
    const html = await renderList({ status: "escalated" });
    expect(html).toContain('aria-label="How the Inbox works"');
    const tabs = html.match(/<nav aria-label="Inbox lists"[\s\S]*?<\/nav>/)?.[0] ?? "";
    const labels = [...tabs.matchAll(/<a [^>]*>([A-Za-z ]+)<span/g)].map((m) => m[1]);
    expect(labels).toEqual(["Need your input", "Design feedback needed"]);
    expect(tabs).toMatch(/aria-current="page"[^>]*>Need your input/);
    expect(tabs).toContain('href="/issues?inbox=design"');
    expect(html.indexOf('aria-label="How the Inbox works"')).toBeLessThan(html.indexOf('aria-label="Inbox lists"'));
    expect(html).not.toContain('aria-label="Filter all issues"');
  });

  it("shows your agents, their status and what they've done beside how the Inbox works", async () => {
    ownAgents.mockResolvedValueOnce([
      { id: "a1", name: "Scout", model: null, level: "working", status: "working", activity: "Working on #3 Seed", lastSeenAt: null },
      { id: "a2", name: "Lens", model: null, level: "working", status: "waiting", activity: "Waiting for your answer", lastSeenAt: null },
    ]);
    workDone.mockResolvedValueOnce(new Map([["a1", { confirmed: 3, rejected: 0, reviews: 1 }]]));
    const html = await renderList({ status: "escalated" });
    const box = html.match(/<section aria-label="How the Inbox works"[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(box).toContain('aria-label="Your agents"');
    // One agent at a time, the one waiting on you first; the dots switch to Scout.
    expect(box).toContain("Lens");
    expect(box).toContain("Waiting for your answer");
    expect(box).toContain("Nothing done in the last 30 days");
    expect(box).not.toContain("Working on #3 Seed");
    expect(box).toContain('aria-label="Show Scout"');
    expect(box).toMatch(/<button[^>]*disabled[^>]*title="Coming soon"[^>]*>Work<\/button>/);
    expect(box).toContain('aria-label="Manage Lens"');
    expect(box).not.toContain(">Manage<");
  });

  it("points to adding an agent when you have none", async () => {
    const html = await renderList({ status: "escalated" });
    expect(html).toContain("No agents yet.");
    expect(html).toContain('href="/settings/agents"');
  });

  it("lists issues with an open redesign under Design feedback needed", async () => {
    await renderList({ status: "escalated", inbox: "design" });
    const where = findMany.mock.calls.at(-1)![0].where;
    expect(where.redesigns).toEqual({ some: { status: "proposed" } });
    expect(where).not.toHaveProperty("agentQuestions");
    expect(where.status).toEqual({ in: ["open", "in_progress"] });
  });

  it("drops the Inbox list choice when moving to another tab", async () => {
    const html = await renderList({ status: "escalated", inbox: "design" });
    const status = html.match(/<nav aria-label="Issue status"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(status).toContain('href="/issues?status=open"');
    expect(status).not.toContain("inbox=");
  });

  it("leaves Inbox unselected on the other tabs", async () => {
    const html = await renderList({ status: "open" });
    const row = html.match(/<div class="issues-tabs-row[\s\S]*?<\/nav>/)?.[0] ?? "";
    const inbox = row.slice(0, row.indexOf('<nav aria-label="Issue status"'));
    expect(inbox).toContain(">Inbox<");
    expect(inbox).not.toContain('aria-current="page"');
  });

  it("shows no tabs when the project has no platforms to choose between (#1055)", async () => {
    groupBy.mockResolvedValue([] as never);
    const { getPlatforms } = await import("@/lib/lookups");
    vi.mocked(getPlatforms).mockResolvedValueOnce([]);
    const html = await renderList();
    expect(html).not.toContain('aria-label="Platforms"');
  });

  it("lands on the Inbox; All (?status=all) shows every issue, finished ones too", async () => {
    let html = await renderList();
    expect(html).toContain('aria-label="How the Inbox works"');
    expect(findMany.mock.calls.at(-1)![0].where.agentQuestions).toEqual({ some: { answeredAt: null } });

    html = await renderList({ q: "login", status: "all" });
    expect(findMany.mock.calls.at(-1)![0].where).not.toHaveProperty("status");
    const status = html.match(/<nav aria-label="Issue status"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(status).toContain('href="/issues?q=login&amp;status=resolved"');
    expect(status).toMatch(/aria-current="page" href="\/issues\?q=login&amp;status=all"/);
  });

  it("searches across All when no tab is picked, so a just-reported issue can be found", async () => {
    const html = await renderList({ q: "login" });
    const where = findMany.mock.calls.at(-1)![0].where;
    expect(where).not.toHaveProperty("agentQuestions");
    expect(where).not.toHaveProperty("status");
    const status = html.match(/<nav aria-label="Issue status"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(status).toMatch(/aria-current="page" href="\/issues\?q=login&amp;status=all"/);
  });

  it("shows a Filter by row under All: All, Closed, Rejected and Duplicates", async () => {
    const html = await renderList({ status: "all" });
    const filters = html.match(/<nav aria-label="Filter all issues"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(filters).toContain("Filter by:");
    const labels = [...filters.matchAll(/<a [^>]*>([A-Za-z]+)<span/g)].map((m) => m[1]);
    expect(labels).toEqual(["All", "Closed", "Rejected", "Duplicates"]);
    expect(filters).toContain('href="/issues?status=closed"');
    expect(filters).toContain('href="/issues?status=rejected"');
    expect(filters).toContain('href="/issues?status=duplicate"');
  });

  it("keeps All selected on its filters and narrows the list: Rejected by a reviewer's verdict, Duplicates by duplicateOf", async () => {
    let html = await renderList({ status: "rejected" });
    expect(findMany.mock.calls.at(-1)![0].where.validations).toEqual({ some: { kind: "real", verdict: "reject" } });
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

  it("lists tested fixes under Done: two independent reviewers said good to merge (Ziki #713)", async () => {
    await renderList({ status: "resolved" });
    const where = findMany.mock.calls.at(-1)![0].where;
    expect(where).toMatchObject({ status: { in: ["open", "in_progress", "resolved"] }, reviewStatus: "tested" });
    expect(where).not.toHaveProperty("AND");
    // The tab counts don't inherit the Done clause.
    const statusCount = groupBy.mock.calls.find(([args]) => args?.by?.[0] === "status")![0];
    expect(statusCount.where).not.toHaveProperty("AND");
  });

  it("counts the work tabs by step, and All also holds closed issues and ones resolved before Ziki #713", async () => {
    groupBy.mockImplementation((async (args: { by: string[]; where?: { reviewStatus?: string } }) =>
      args.by[0] !== "status"
        ? []
        : args.where?.reviewStatus === "ready_to_merge"
          // Accepted fixes keep their status: one is still in progress, one was resolved.
          ? [
              { status: "in_progress", _count: { _all: 1 } },
              { status: "resolved", _count: { _all: 1 } },
            ]
          : args.where?.reviewStatus === "tested"
            // Two fixes with two good-to-merge verdicts, still in progress.
            ? [{ status: "in_progress", _count: { _all: 2 } }]
            : [
              { status: "open", _count: { _all: 9 } },
              { status: "in_progress", _count: { _all: 5 } },
              { status: "resolved", _count: { _all: 7 } },
              { status: "closed", _count: { _all: 3 } },
            ]) as never);
    count.mockImplementation((async (args: { where?: { reviewStatus?: string } }) =>
      args?.where?.reviewStatus === "merged" ? 3 : 0) as never);
    const html = await renderList({ status: "all" });
    const nav = html.match(/<nav aria-label="Issue status"[\s\S]*?<\/nav>/)?.[0] ?? "";
    const counts = Object.fromEntries(
      [...nav.matchAll(/<\/span>([A-Za-z ]+)<span class="issues-status-count">(\d+)<\/span>/g)].map((m) => [m[1], Number(m[2])]),
    );
    // In progress = 5 - 1 waiting to merge - 2 tested. Done = the 2 tested fixes (Ziki #713).
    // Ideas are not issues, so their tab is outside the All total (#idea-table).
    expect(counts).toEqual({ Ideas: 4, Open: 9, "In progress": 2, Done: 2, "Ready to Merge": 2, Live: 3, All: 24 });
    // The other 6 are closed (3) or were resolved without a merge (3): they stay under All only.
    expect(counts.All - (counts.Open + counts["In progress"] + counts.Done + counts["Ready to Merge"] + counts.Live)).toBe(6);
  });

  it("lists an accepted fix on Ready to Merge whatever its status, and keeps it off Open and In progress", async () => {
    await renderList({ status: "ready_to_merge" });
    expect(findMany.mock.calls.at(-1)![0].where).toMatchObject({
      status: { in: ["open", "in_progress", "resolved"] },
      reviewStatus: "ready_to_merge",
    });
    await renderList({ status: "in_progress" });
    expect(findMany.mock.calls.at(-1)![0].where.AND).toEqual([
      { OR: [{ reviewStatus: null }, { reviewStatus: { not: "ready_to_merge" } }] },
      // Ziki #713: a tested fix is on Done instead.
      { OR: [{ reviewStatus: null }, { reviewStatus: { not: "tested" } }] },
    ]);
  });

  it("shows the vote count once and no proof-link count in rows (#1060)", async () => {
    const html = await renderList();
    expect(html).not.toContain("🔗");
    expect(html).not.toContain("linked proof");
    expect(html).not.toContain("👍");
    expect(html).not.toContain("👎");
    // The voters' faces aren't repeated under the row.
    expect(html).not.toContain(">Ann<");
    expect(findMany.mock.calls.at(-1)![0].select).not.toHaveProperty("proofLinks");
  });

  it("shows the assignee as a face only, and a short updated date (#1061)", async () => {
    const html = await renderList();
    // The name is only in the tooltip and for screen readers.
    expect(html).toContain('title="Assigned to Bob Builder"');
    expect(html).toContain('<span class="sr-only">Assigned to Bob Builder</span>');
    expect(html).not.toContain("max-w-[10rem] truncate");
    // "Updated" means updatedAt (Oct 20), not when it was opened (Oct 1).
    expect(html).toMatch(/<time dateTime="2026-10-20T10:00:00.000Z" title="Updated Oct 20, 2026/);
    expect(html).not.toContain(">updated<");
  });

  it("dates rows by when they were opened when sorted by newest (#1061)", async () => {
    const html = await renderList({ sort: "newest" });
    expect(html).toMatch(/<time dateTime="2026-10-01T10:00:00.000Z" title="Opened /);
  });

  it("keeps the row unwatch action visible in the compact mobile layout", async () => {
    const html = await renderList({ mine: "watching" });

    expect(html).toContain('class="w-10 shrink-0 items-center justify-end gap-2 flex"');
    expect(html).toMatch(/aria-label="Unwatch [^"]*Login button does nothing"/);
  });
});
