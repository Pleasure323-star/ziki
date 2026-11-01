import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/** The issue list: the main status tabs and their counts, filters that keep search and scope, rows that link to the issue, and ideas listed apart from issues. */
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
  usePathname: () => "/acme/issues/all",
  useParams: () => ({ project: "acme" }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "dave" } })) }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: vi.fn(async () => ({ id: "dave", role: "user" })) }));
// #project-urls: the slug in the address picks the project and checks access.
vi.mock("@/lib/project-route", () => ({
  requireProject: vi.fn(async () => ({
    user: { id: "dave", role: "user" },
    tenantId: "tenant-acme",
    project: { id: "project-acme", slug: "acme", name: "Acme Web", goal: null, tenantId: "tenant-acme" },
  })),
}));
vi.mock("@/lib/tenant-access", () => ({ currentTenantAccess: vi.fn(async () => ({ membershipRole: "member" })) }));
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

import { IssuesList } from "@/app/(app)/[project]/issues/_list/issues-list";

const BUG = {
  id: "bug-1",
  number: 7,
  title: "Login button does nothing",
  description: "## Summary\nLogin button does nothing\n\n## Acceptance Criteria\n- [ ] Fix login",
  createdByAgentId: null,
  status: "open",
  substatus: "requires_confirmation",
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
  project: { slug: "acme" },
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

/** Renders `/acme/issues/<status>`, or `/acme/ideas` when no status is given. */
async function renderList({ status, ...query }: Record<string, string> = {}) {
  const returnTo = status ? `/acme/issues/${status}` : "/acme/ideas";
  const page = (await IssuesList({ slug: "acme", status, returnTo, searchParams: Promise.resolve(query) })) as ReactElement;
  return renderToStaticMarkup(page);
}

const clean = (html: string) => html.replace(/<!-- -->/g, "");
/** The stage bar above the panel, and the status list down its left. */
const stages = (html: string) => clean(html).match(/<nav aria-label="Stages"[\s\S]*?<\/nav>/)?.[0] ?? "";
const statusList = (html: string) => clean(html).match(/<nav aria-label="Status"[\s\S]*?<\/nav>/)?.[0] ?? "";
const links = (nav: string) => [...nav.matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
const labelOf = (link: string) => link.match(/>([A-Za-z][A-Za-z ]*?)(?:<span|<\/a>)/)?.[1] ?? "";
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
  it("links each row to its project address and offers a new-issue link", async () => {
    const html = await renderList({ status: "all" });
    expect(html).toContain("Login button does nothing");
    // #project-urls: a row opens the issue at /<project-slug>/<number>.
    expect(html).toContain('href="/acme/7"');
    expect(html).toContain('href="/acme/issues/new?from=');
  });

  it("says no issues match when the project has issues but the filters hide them", async () => {
    count.mockImplementation(async (args: { where?: { assigneeId?: unknown } }) => (args?.where?.assigneeId ? 0 : 3));
    findMany.mockResolvedValue([]);
    const html = await renderList({ mine: "assigned", status: "all" });
    expect(html).toMatch(/no issues match/i);
    expect(html).toContain("Clear filters");
    expect(html).not.toMatch(/no issues yet/i);
  });

  it("lists ideas under Ideas' New ideas, from the Idea table, with their score and no importance button (#idea-table)", async () => {
    const html = await renderList();
    expect(ideaFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: "tenant-acme", projectId: "project-acme", status: "open", isDeleted: false }),
    }));
    expect(html).toContain('href="/acme/ideas/12"');
    expect(html).toContain("Idea #12");
    expect(html).toContain('aria-label="Idea score 2 of 4"');
    expect(html).toContain("3 verdicts");
    expect(html).not.toMatch(/click to mark important/);
    // No issue row matches an idea list.
    expect(findMany.mock.calls.at(-1)![0].where.id).toEqual({ in: [] });
  });

  it("keeps search and scope when switching status, and resets paging and intake", async () => {
    const html = await renderList({ q: "login", platform: "cat-web", mine: "assigned", stage: "reported", page: "2", status: "open" });
    const list = statusList(html);
    // #project-urls: the status is the path, the rest stays in the query.
    expect(list).toContain('href="/acme/issues/in-progress?q=login&amp;platform=cat-web&amp;mine=assigned"');
    expect(list).not.toContain("page=");
    expect(list).not.toContain("stage=");
    const statusCount = groupBy.mock.calls.find(([args]) => args?.by?.[0] === "status");
    expect(statusCount?.[0].where).toMatchObject({ tenantId: "tenant-acme", projectId: "project-acme", categoryId: "cat-web" });
    expect(statusCount?.[0].where).not.toHaveProperty("status");
  });

  it("lists both of Open's substatuses on its tab, by the main status (#substatus)", async () => {
    await renderList({ status: "open" });
    const where = findMany.mock.calls.at(-1)![0].where;
    expect(where.status).toBe("open");
    expect(where).not.toHaveProperty("substatus");
  });

  it("searches across All when no stage is picked, so a just-reported issue can be found", async () => {
    const html = await renderList({ q: "login" });
    const where = findMany.mock.calls.at(-1)![0].where;
    expect(where).not.toHaveProperty("id");
    expect(where).not.toHaveProperty("status");
    expect(current(stages(html))).toEqual([]);
  });

  it("lists each tab by its main status (Ziki #713, #substatus)", async () => {
    for (const status of ["in_progress", "done", "merge", "resolved"]) {
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
          { status: "open", _count: { _all: 13 } },
          { status: "in_progress", _count: { _all: 2 } },
          { status: "done", _count: { _all: 7 } },
          { status: "merge", _count: { _all: 1 } },
          { status: "resolved", _count: { _all: 7 } },
          { status: "closed", _count: { _all: 3 } },
        ]) as never);
    const html = await renderList({ status: "open" });
    // Ideas: new ideas + rejected ideas. Working: Open, In progress, Closed. Delivered: Done, Merge, Live.
    expect(counted(stages(html))).toEqual({ Ideas: 8, Working: 18, Delivered: 15 });
    expect(counted(statusList(html))).toEqual({ Open: 13, "In progress": 2, Closed: 3 });
  });

});
