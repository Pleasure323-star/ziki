import Link from "next/link";
import { newIssueHref } from "@/lib/reported-from";
import "./issues.css";
import { Avatar } from "@/components/avatar";
import { Suspense } from "react";
import { RememberIssueList } from "@/components/back-to-list";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getIssueTypes, getPlatforms } from "@/lib/lookups";
import { auth } from "@/auth";
import { requireUser } from "@/lib/auth-helpers";

import { ProjectNotesLink } from "@/components/project-notes-link";
import { PipelineSteps } from "@/components/pipeline-steps";
import { StageSidebar } from "@/components/stage-sidebar";
import type { AppRole } from "@/lib/roles";
import { IssueFilters } from "@/components/issue-filters";
import { RowAge, RowAssignee } from "@/components/issue-row-meta";
import { IdeasList, type IdeaListRow } from "@/components/ideas-list";
import { WhimsicalEmptyState } from "@/components/whimsical-empty-state";
import { isUnstructuredDraft } from "@/lib/ideas";
import { workflowFor } from "@/lib/workflow";
import { ideaVotes, isBadIdea } from "@/lib/idea-rejection";
import { statuses } from "@/lib/validations/issue";
import { boundSearchTerm, escapeSearchQuery, toSingleQueryParam } from "@/lib/search";
import {
  hasMatch,
  highlightSegments,
  markdownToPlain,
  matchSnippet,
  type Snippet,
} from "@/lib/search-snippet";
import { Highlighted, SearchSnippet } from "@/components/search-highlight";
import { formatIssueNumber, parseIssueNumberQuery } from "@/lib/issue-number";
import {
  SHOW_RESOLVED_PARAM,
  isDone,
  parseShowResolved,
  resultCountText,
  statusFilterLabel,
  statusFilterWhere,
} from "@/lib/issue-state";
import { calculatePagination } from "@/lib/pagination";
import { issueListPaginationParams } from "@/lib/issue-list-pagination";
import { DUPLICATES_PARAM, SHOW_DUPLICATES, duplicatesWhere, parseShowDuplicates } from "@/lib/duplicates";
import { PaginationControls } from "@/components/pagination-controls";
import { dueDateValue, MILESTONE_PARAM, milestoneParamValue, milestoneWhere, parseMilestoneFilter } from "@/lib/milestones";
import { loadMilestoneSummaries } from "@/lib/milestone-stats";
import { MilestoneProgressBar } from "@/components/milestone-progress";
import { MilestoneDue } from "@/components/milestone-due";
import {
  bugSortDescriptions,
  getBugOrderBy,
  parseBugSort,
} from "@/lib/issues-sort";
import { canDeleteTicket } from "@/lib/ticket-deletion";
import { currentTenantAccess } from "@/lib/tenant-access";
import type { OrganizationRole } from "@/lib/organization-role";
import { defaultSortFor, mineFilterWhere, parseMineFilter } from "@/lib/mine-filter";
import { finishedWatchedWhere } from "@/lib/watching";
import { UnwatchButton, UnwatchFinishedButton } from "@/components/unwatch-button";
import { parseTagFilter, serializeTags, tagTypeIds } from "@/lib/tag-filter";
import { bugInTenant, currentTenantIdFor, isMissingTenantColumnError } from "@/lib/tenant-context";
import { activeProjectIdFor } from "@/lib/project-context";
import { RichText } from "@/components/rich-text";
import { isOrganizationAdmin } from "@/lib/organization-role";
import { cookies } from "next/headers";
import { GettingStarted } from "@/components/getting-started";
import { GETTING_STARTED_COOKIE, gettingStartedFor, parseDismissed, type GettingStartedStep } from "@/lib/onboarding";
import {
  PLATFORM_NONE,
  PLATFORM_PARAM,
  parsePlatformFilter,
  platformChoices,
  platformFilterWhere,
} from "@/lib/platform-filter";
import { PlatformMenu, type PlatformTab } from "@/components/platform-tabs";
import { ConfirmationCountBadge, IssueRowStatus } from "@/components/issue-row-status";
import { mergePathOf } from "@/lib/merge-history";
import { IssuesToolsToggle } from "@/components/issues-tools-toggle";
import { LoadError } from "@/components/load-error";
import { logLoadFailure } from "@/lib/load-error";
import { AREA_PARAM, parseProjectAreaFilter, projectAreaFilterWhere } from "@/lib/project-area-filter";
import { openIssueConfirmations, parseIssueStageView, type IssueStage } from "@/lib/issue-stage";
import { issuePath } from "@/lib/issue-ref";
import { PROJECT_ALL_PARAM, showsAllProjects } from "@/lib/issue-list-filters";
import { CountBadge } from "@/components/count-badge";

/* Distinct browser-tab title; the root layout appends "· Ziki". */
export const metadata = { title: "Issues" };

/** `?status=all`: every issue. With no `?status=` the page opens on Ideas. */
const ALL_STATUS = "all";
/** The Ideas tab, the page with no `?status=`. Ideas are not issues: they read the Idea table (#idea-table). */
const IDEAS_STATUS = "ideas";
/** Ideas a manager agent rejected (#idea-rejected), the second list under Ideas. */
const REJECTED_IDEAS_STATUS = "rejected_ideas";

/** The filters under the Ideas tab: new ideas (no `?ideas=`), or `?ideas=drafts`. */
const IDEAS_PARAM = "ideas";
type IdeasView = "new" | "drafts" | "rejected";
/** Most ideas a list shows, highest score first. */
const IDEAS_LIMIT = 100;

/** `?status=rejected`: someone's confirmation entry rejected the issue (#1122, #issue-confirmations). */
const REJECTED_STATUS = "rejected";
const REJECTED_WHERE = { some: { verdict: "reject", undoneAt: null } } satisfies Prisma.IssueConfirmationListRelationFilter;
/** `?status=duplicate`: marked as a duplicate of another issue. */
const DUPLICATE_STATUS = "duplicate";
/** The filters under the All tab. Every status has a tab of its own. */
const ALL_FILTERS = [ALL_STATUS, REJECTED_STATUS, DUPLICATE_STATUS].map((value) => ({
  value,
  label: statusFilterLabel(value),
}));
/**
 * The three stages across the top, each holding the statuses listed down the
 * left of the panel when it is picked. Ideas (the Idea table) comes first.
 */
const STAGE_GROUPS = [
  // Ideas holds only ideas; Requires confirmation is an issue's first status, so it opens Working.
  { label: "Ideas", statuses: [IDEAS_STATUS, REJECTED_IDEAS_STATUS] },
  { label: "Working", statuses: ["requires_confirmation", "open", "in_progress", "closed"] },
  { label: "Delivered", statuses: ["delivered", "done", "ready_to_merge", "resolved"] },
] as const;

/** "+ Add Idea": every report starts as an idea (#idea-table). */
function NewIssueButton({ className = "" }: { className?: string }) {
  return (
    <Link
      href={newIssueHref("/issues")}
      title="Add Idea"
      className={`issues-new inline-flex items-center justify-center gap-1.5 rounded-lg border border-zk-border bg-zk-surface px-2.5 text-[13px] font-semibold text-zk-text hover:bg-zk-chip ${className}`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      Add Idea
    </Link>
  );
}

/** A bug with head, antennae, segmented body and three pairs of legs. */
const BUG_ICON_PATH =
  "m8 2 1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3 3 0 1 1 6 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4";

/** A sparkle, for feature and improvement types. */
const FEATURE_ICON_PATH =
  "m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z";

type SearchParams = Promise<{
  q?: string | string[];
  status?: string | string[];
  platform?: string | string[];
  area?: string | string[];
  sort?: string | string[];
  page?: string | string[];
  deleted?: string | string[];
  mine?: string | string[];
  tags?: string | string[];
  [key: string]: string | string[] | undefined;
}>;

async function loadOrEmpty<T>(label: string, load: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await load();
  } catch (error) {
    console.error(`[bugs] ${label} lookup failed`, error);
    return empty;
  }
}

/** The database error stays in the server log under `reference` (#506). */
function issuesQueryError(reference: string, message?: string) {
  return (
    <LoadError title="Issues could not be loaded" reference={reference}>
      {message}
    </LoadError>
  );
}

export default async function BugsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  let userId: string | undefined;
  let effectiveRole: AppRole | null | undefined;
  let membershipRole: OrganizationRole | null = null;

  if (session?.user) {
    const user = await requireUser();
    userId = user.id;
    effectiveRole = user.role;
    membershipRole = (await currentTenantAccess(user.id, user.role)).membershipRole;
  }
  // #425: only issues in the viewer's tenant; none without a membership.
  let tenantId: string | null = null;
  let projectId: string | null = null;
  try {
    tenantId = await currentTenantIdFor(userId);
    projectId = await activeProjectIdFor(prisma, tenantId);
  } catch (error) {
    console.error("[bugs] tenant/project resolution failed", error);
  }
  const activeProject = tenantId && projectId
    ? await prisma.project.findFirst({ where: { id: projectId, tenantId }, select: { slug: true, name: true, goal: true } }).catch(() => null)
    : null;

  // #641: a short checklist for a new workspace's owner or admin, until it's
  // done or dismissed on this device.
  let gettingStarted: { tenantId: string; workspaceName: string; steps: GettingStartedStep[] } | null = null;
  if (tenantId && userId && membershipRole && isOrganizationAdmin(membershipRole, effectiveRole)) {
    try {
      const dismissed = parseDismissed((await cookies()).get(GETTING_STARTED_COOKIE)?.value);
      if (!dismissed.includes(tenantId)) {
        const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, slug: true } });
        if (tenant) {
          const checklist = await gettingStartedFor(prisma, tenantId, { tenantSlug: tenant.slug });
          if (!checklist.complete) gettingStarted = { tenantId, workspaceName: tenant.name, steps: checklist.steps };
        }
      }
    } catch (error) {
      console.error("[bugs] getting-started checklist failed", error);
    }
  }

  const canDelete = canDeleteTicket(effectiveRole, membershipRole);
  const params = await searchParams;
  const qParam = toSingleQueryParam(params.q);
  // No ?status= opens Ideas; ?status=all is the All tab.
  // A search with no tab picked looks across All, so any issue can be found.
  const statusParam =
    toSingleQueryParam(params.status) ??
    (toSingleQueryParam(params.deleted) === "true" ? undefined : toSingleQueryParam(params.q)?.trim() ? ALL_STATUS : IDEAS_STATUS);
  const sortParam = toSingleQueryParam(params.sort);
  const pageParam = toSingleQueryParam(params.page);
  const deletedParam = toSingleQueryParam(params.deleted);
  const mineFilter = parseMineFilter(params.mine);
  const isDeletedView = canDelete && deletedParam === "true";
  // Workspace-wide view (dashboard links). Absent → unchanged project scope.
  const allProjects = showsAllProjects(params[PROJECT_ALL_PARAM]);

  const currentSort = parseBugSort(sortParam, defaultSortFor(mineFilter));
  const isWatchingView = mineFilter === "watching" && !!userId;
  // #285: duplicates are hidden unless asked for, and the count says so.
  const showDuplicates = parseShowDuplicates(params[DUPLICATES_PARAM]);
  const where: Prisma.BugWhereInput = {
    ...bugInTenant(tenantId),
    ...(projectId && !allProjects ? { projectId } : {}),
    isDeleted: isDeletedView,
    ...mineFilterWhere(mineFilter, userId),
    ...duplicatesWhere(showDuplicates),
  };

  // Tag filter (#102): issue types picked from the search box.
  // These lookups are filters only. Each one fails on its own: Promise.all
  // used to throw away the ones that succeeded when Milestone was missing,
  // and the admin path below then queried them again outside this catch.
  const [tagTypes, platforms, milestones, areas, userPrefs] = await Promise.all([
    // Cached, expired by the admin actions that change them (#297).
    loadOrEmpty("issue types", () => getIssueTypes(tenantId), []),
    // Every platform, not just active ones: a link filtered on a platform
    // that was since deactivated still has to resolve. BugFilters narrows
    // the dropdown itself.
    loadOrEmpty("platforms", () => getPlatforms(tenantId), []),
    // #289: few rows; closed ones too, so an old link still resolves.
    loadOrEmpty(
      "milestones",
      () =>
        tenantId
          ? prisma.milestone.findMany({
              where: { tenantId },
              select: { id: true, title: true, isClosed: true },
              orderBy: [{ isClosed: "asc" }, { dueDate: { sort: "asc", nulls: "last" } }, { title: "asc" }],
            })
          : Promise.resolve([]),
      [],
    ),
    loadOrEmpty(
      "project areas",
      () => projectId
        ? prisma.projectArea.findMany({ where: { projectId }, select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] })
        : Promise.resolve([]),
      [],
    ),
    userId && prisma.user?.findUnique
      ? prisma.user
          .findUnique({
            where: { id: userId },
            select: { keyboardShortcuts: true },
          })
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  const shortcutsEnabled = userPrefs?.keyboardShortcuts ?? true;
  const selectedMilestone = parseMilestoneFilter(params[MILESTONE_PARAM], milestones);
  const milestoneParam = milestoneParamValue(selectedMilestone);
  const selectedTags = parseTagFilter(params.tags, tagTypes);
  if (selectedTags.length > 0) {
    where.typeId = { in: tagTypeIds(selectedTags, tagTypes) };
  }
  const tagsParam = serializeTags(selectedTags.map((t) => t.name));

  const statusWhere = statusFilterWhere(statusParam);
  // Each status tab filters on its status alone (one status per issue). With no
  // status filter the All tab shows every issue.
  const showResolved = parseShowResolved(params[SHOW_RESOLVED_PARAM]);
  if (statusWhere !== undefined) where.status = statusWhere;
  // The Ideas tab lists ideas from their own table: no issue row matches it.
  const ideasView: IdeasView | null =
    isDeletedView
      ? null
      : statusParam === REJECTED_IDEAS_STATUS
        ? "rejected"
        : statusParam !== IDEAS_STATUS
          ? null
          : toSingleQueryParam(params[IDEAS_PARAM]) === "drafts"
            ? "drafts"
            : "new";
  const isIdeasView = ideasView !== null;
  if (isIdeasView) where.id = { in: [] };
  if (statusParam === REJECTED_STATUS && !isDeletedView) {
    where.confirmations = REJECTED_WHERE;
  }
  if (statusParam === DUPLICATE_STATUS && !isDeletedView) {
    where.duplicateOfId = { not: null };
  }
  // Platform filter: one category, or the issues with none set.
  const selectedPlatform = parsePlatformFilter(params.platform, platforms);
  Object.assign(where, platformFilterWhere(selectedPlatform));
  const selectedArea = parseProjectAreaFilter(params[AREA_PARAM], areas);
  Object.assign(where, projectAreaFilterWhere(selectedArea));
  Object.assign(where, milestoneWhere(selectedMilestone));
  if (qParam?.trim()) {
    const q = escapeSearchQuery(boundSearchTerm(qParam));
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { description: { contains: q, mode: "insensitive" } },
    ];
    // "42" or "#42" should also find issue #42, which is how people quote an
    // issue to each other. Left as an OR so a title containing "42" still
    // matches too, rather than the number silently hijacking the search.
    const asNumber = parseIssueNumberQuery(qParam);
    if (asNumber !== null) where.OR.push({ number: asNumber });
  }

  let totalCount = 0;
  try {
    totalCount = await prisma.bug.count({ where });
  } catch (error) {
    const reference = logLoadFailure("[bugs] list count failed", error);
    const missingColumn = isMissingTenantColumnError(error);
    if (!tenantId) {
      // No membership: nothing to show either way (#439).
      totalCount = 0;
      if (missingColumn) {
        delete where.tenantId;
        delete where.projectId;
        where.id = { in: [] };
      }
    } else if (missingColumn) {
      // #506: never retry without the tenant filter. That used to show every
      // tenant's issues to anyone whose query error mentioned the column.
      return issuesQueryError(
        reference,
        "The issue list is unavailable while the database finishes upgrading. Try again in a minute.",
      );
    } else {
      return issuesQueryError(reference);
    }
  }

  const stageView: IssueStage | null = isDeletedView || isIdeasView
    ? null
    : parseIssueStageView(toSingleQueryParam(params.stage));
  let stages = new Map<string, IssueStage>();
  // How many independent people confirmed each open issue, under the one rule (#issue-confirmations).
  let confirmationCounts = new Map<string, number>();
  let confirmationStates = new Map<string, { accepts: number; needed: number; confirmed: boolean }>();
  if (!isDeletedView) {
    try {
      const confirmations = await openIssueConfirmations(prisma, where);
      stages = new Map([...confirmations].map(([id, c]) => [id, c.stage]));
      confirmationCounts = new Map([...confirmations].map(([id, c]) => [id, c.accepts]));
      confirmationStates = new Map([...confirmations].map(([id, c]) => [id, { accepts: c.accepts, needed: c.needed, confirmed: c.confirmed }]));
    } catch (error) {
      console.error("[bugs] issue stage lookup failed", error);
    }
    if (stageView) {
      const ids = [...stages.entries()].filter(([, stage]) => stage === stageView).map(([id]) => id);
      where.id = { in: ids };
      try {
        totalCount = await prisma.bug.count({ where });
      } catch (error) {
        console.error("[bugs] stage count failed", error);
        totalCount = 0;
      }
    }
  }
  // #1055: every tab counts what the other filters match, whatever platform
  // is picked, so switching tabs never surprises. The snapshot is taken after
  // the stage clause is applied (#626): a ?stage= page must count the same
  // rows its result list shows — tabs, badges and the "Show N resolved" link
  // all follow the stage filter, not the pre-stage row set.
  // Count the same tenant/project and search scope without the selected tab:
  // its status, and the extra clauses Ideas, Rejected, Duplicates,
  // Ready to Merge and Live add. Left in, those leaked into every other tab's
  // count (on Ready to Merge, "All" only counted ready-to-merge issues).
  const {
    status: _selectedStatus,
    id: _stageIds,
    confirmations: _rejected,
    duplicateOfId: _duplicate,
    AND: _notMergeStage,
    ...tabScope
  } = where;
  // Put the default duplicate scope back: the Duplicates filter's override is
  // dropped, but tabs and counts still leave out the duplicates the list hides.
  const statusTabWhere: Prisma.BugWhereInput = { ...tabScope, ...duplicatesWhere(showDuplicates) };
  void _selectedStatus;
  void _stageIds;
  void _rejected;
  void _duplicate;
  void _notMergeStage;
  // The platform menu counts each platform's issues whatever tab is picked,
  // so its numbers don't move as you switch tabs; the tabs then split the
  // picked platform's total. A ?stage= from the URL still narrows it (#626).
  const stageFromUrl = stageView !== null;
  const { categoryId: _platformClause, ...platformTabWhere }: Prisma.BugWhereInput = {
    ...statusTabWhere,
    ...(stageFromUrl ? { id: where.id } : {}),
  };
  void _platformClause;

  let platformTabs: PlatformTab[] = [];
  if (!isDeletedView) {
    try {
      const grouped = await prisma.bug.groupBy({
        by: ["categoryId"],
        where: platformTabWhere,
        _count: { _all: true },
      });

      const counts = new Map(grouped.map((row) => [row.categoryId, row._count._all]));
      const all = grouped.reduce((sum, row) => sum + row._count._all, 0);

      const choices = platformChoices(platforms, selectedPlatform);
      if (choices.length > 0) {
        platformTabs = [
          { id: null, name: "All", count: all },
          // Active platforms, plus a deactivated one if a link picked it.
          ...choices.map((platform) => ({
            id: platform.id,
            name: platform.name,
            count: counts.get(platform.id) ?? 0,
          })),
          {
            id: PLATFORM_NONE,
            name: "No platform",
            count: counts.get(null) ?? 0,
          },
        ];
      }
    } catch (error) {
      console.error("[bugs] platform tab counts failed", error);
    }
  }
  const platformHref = (id: string | null) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (key === "page" || key === PLATFORM_PARAM) continue;
      if (isIdeasView && key === IDEAS_PARAM) continue;
      const single = toSingleQueryParam(value);
      if (single) next.set(key, single);
    }
    // Platforms filter issues, so picking one from Ideas opens All.
    if (isIdeasView) next.set("status", ALL_STATUS);
    if (id) next.set(PLATFORM_PARAM, id);
    const qs = next.toString();
    return qs ? `/issues?${qs}` : "/issues";
  };

  // How many the default view is hiding, so "Show duplicates" can say so.
  let hiddenDuplicates = 0;
  if (!showDuplicates) {
    try {
      hiddenDuplicates = await prisma.bug.count({
        where: { ...where, duplicateOfId: { not: null } },
      });
    } catch (error) {
      console.error("[bugs] duplicate count failed", error);
    }
  }
  const duplicatesHref = (() => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      const v = Array.isArray(value) ? value[0] : value;
      if (v && key !== DUPLICATES_PARAM && key !== "page") next.set(key, v);
    }
    if (!showDuplicates) next.set(DUPLICATES_PARAM, SHOW_DUPLICATES);
    const qs = next.toString();
    return qs ? `/issues?${qs}` : "/issues";
  })();

  const pagination = calculatePagination({
    page: pageParam,
    totalCount,
  });

  // Select only what the list shows: no `description` (up to 5000 chars
  // each), which the list never displays (#217).
  const listed = await prisma.bug
    .findMany({
      where,
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        // A closed issue says why when agents closed it (#close-superseded).
        closeReason: true,
        voteCount: true,
        projectId: true,
        isDeleted: true,
        isBoosted: true,
        duplicateOf: showDuplicates ? { select: { number: true } } : false,
        createdAt: true,
        updatedAt: true,
        // A live fix shows its dev → staging → main chips in the status column.
        pullRequestUrl: true,
        type: { select: { name: true } },
        reporter: { select: { name: true, role: true, image: true } },
        assignee: { select: { name: true, role: true, image: true } },
        // Who is working on it and since when, for the status column.
        // The claim working on it, or an offer waiting to be accepted.
        claims: {
          where: { status: { in: ["active", "offered"] }, releasedAt: null },
          select: { status: true, claimedAt: true, createdAt: true, beneficiary: { select: { name: true } } },
          orderBy: { createdAt: "desc" },
          take: 2,
        },
        category: { select: { id: true, name: true } },
        area: { select: { id: true, name: true } },
        _count: {
          select: {
            comments: true,
            attachments: true,
            // Open bids, shown on Open issues.
            bids: { where: { withdrawnAt: null } },
          },
        },
      },
      // A personal list reads newest-activity-first; boosts are for the shared one.
      orderBy: getBugOrderBy(currentSort, { boostFirst: !isWatchingView }),
      skip: pagination.skip,
      take: pagination.take,
    })
    .then((bugs) => ({ bugs }))
    .catch((error: unknown) => ({ reference: logLoadFailure("[bugs] list query failed", error) }));
  if ("reference" in listed) {
    return issuesQueryError(listed.reference);
  }
  const bugs = listed.bugs;

  // #idea-table: the Ideas tab's New ideas and Drafted read open ideas from
  // their own table, in the same tenant, project and search scope as the
  // issues. A draft is a person's idea not yet written up in the standard
  // headings.
  const ideaWhere: Prisma.IdeaWhereInput = {
    tenantId: tenantId ?? "",
    ...(projectId && !allProjects ? { projectId } : {}),
    isDeleted: false,
    status: "open",
    ...(qParam?.trim()
      ? {
          OR: [
            { title: { contains: escapeSearchQuery(boundSearchTerm(qParam)), mode: "insensitive" } },
            { description: { contains: escapeSearchQuery(boundSearchTerm(qParam)), mode: "insensitive" } },
          ],
        }
      : {}),
  };
  // Rejected ideas (#idea-rejected), with the same scope and search as new ones.
  const rejectedIdeaWhere: Prisma.IdeaWhereInput = { ...ideaWhere, status: "rejected" };
  // The Ideas tab's counts show on every tab; drafts only while Ideas is open.
  const [ideasCount, rejectedIdeasCount, draftIds] = await Promise.all([
    tenantId && !isDeletedView ? loadOrEmpty("ideas tab", () => prisma.idea.count({ where: ideaWhere }), 0) : 0,
    tenantId && !isDeletedView ? loadOrEmpty("rejected ideas tab", () => prisma.idea.count({ where: rejectedIdeaWhere }), 0) : 0,
    tenantId && isIdeasView
      ? loadOrEmpty(
          "drafted ideas",
          async () =>
            (await prisma.idea.findMany({ where: { ...ideaWhere, createdByAgentId: null }, select: { id: true, description: true, createdByAgentId: true } }))
              .filter(isUnstructuredDraft)
              .map((idea) => idea.id),
          [] as string[],
        )
      : ([] as string[]),
  ]);
  const ideaRows: IdeaListRow[] = isIdeasView && tenantId
    ? await loadOrEmpty("ideas list", async () => {
        const rows = await prisma.idea.findMany({
          where: ideasView === "drafts" ? { ...ideaWhere, id: { in: draftIds } } : ideasView === "rejected" ? rejectedIdeaWhere : ideaWhere,
          orderBy: [{ score: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          take: IDEAS_LIMIT,
          select: {
            id: true, number: true, title: true, score: true, projectId: true, createdAt: true,
            reporter: { select: { name: true } },
            category: { select: { name: true } },
            _count: { select: { verdicts: true } },
          },
        });
        const thresholds = new Map<string, number | null>();
        for (const id of new Set(rows.map((row) => row.projectId))) {
          thresholds.set(id, await workflowFor(id).then((w) => w.ideaThreshold).catch(() => null));
        }
        // Each idea's votes, to mark the bad ones red (lib/idea-rejection.ts).
        const voteRows = rows.length
          ? await prisma.ideaVerdict.groupBy({
              by: ["ideaId", "opinion"],
              where: { ideaId: { in: rows.map((row) => row.id) } },
              _sum: { votes: true },
            })
          : [];
        const votesByIdea = new Map<string, { opinion: string; votes: number }[]>();
        for (const row of voteRows) {
          votesByIdea.set(row.ideaId, [...(votesByIdea.get(row.ideaId) ?? []), { opinion: row.opinion, votes: row._sum.votes ?? 0 }]);
        }
        return rows.map((row) => ({
          id: row.id,
          number: row.number,
          title: row.title,
          score: row.score,
          threshold: thresholds.get(row.projectId) ?? null,
          createdAt: row.createdAt,
          reporterName: row.reporter.name,
          platform: row.category?.name ?? null,
          verdicts: row._count.verdicts,
          rejected: ideasView === "rejected",
          bad: ideasView !== "rejected" && (thresholds.get(row.projectId) ?? null) !== null
            && isBadIdea(ideaVotes(votesByIdea.get(row.id) ?? []), thresholds.get(row.projectId)!),
        }));
      }, [] as IdeaListRow[])
    : [];

  // #301: when searching, show why a row matched. Only rows whose title
  // doesn't already contain the query need their description, so the list
  // query still never selects it (#217) and a search whose hits are all in
  // titles costs nothing extra. No search → no query at all.
  const searchText = qParam?.trim() ?? "";
  const snippets = new Map<string, Snippet>();
  if (searchText) {
    const needDescription = bugs
      .filter((bug) => !hasMatch(bug.title, searchText))
      .map((bug) => bug.id);
    if (needDescription.length > 0) {
      try {
        const rows = await prisma.bug.findMany({
          where: { id: { in: needDescription } },
          select: { id: true, description: true },
        });
        for (const row of rows) {
          const snippet = matchSnippet(markdownToPlain(row.description), searchText);
          if (snippet) snippets.set(row.id, snippet);
        }
      } catch (error) {
        // A snippet is a nicety; the results themselves are already loaded.
        console.error("[bugs] search snippets failed", error);
      }
    }
  }


  // #289: filtering on one milestone shows its progress above the list.
  let milestoneSummary: Awaited<ReturnType<typeof loadMilestoneSummaries>>[number] | null = null;
  if (selectedMilestone && selectedMilestone !== "none") {
    try {
      [milestoneSummary] = await loadMilestoneSummaries({
        id: selectedMilestone.id,
        tenantId: tenantId ?? undefined,
      });
    } catch (error) {
      console.error("[bugs] milestone summary failed", error);
    }
  }

  // "No issues match" and "there are no issues yet" need different pages
  // (#292): filter advice on an empty tracker sends people looking for a
  // filter that is not there. The extra count only runs when the page is
  // already empty, so a populated list pays nothing for it. It counts the
  // same scope the list shows, including ?project=all, so an empty filter
  // across a busy workspace is "no issues match", not "no issues yet".
  let isFirstRun = false;
  if (totalCount === 0 && !isDeletedView) {
    try {
      isFirstRun = (await prisma.bug.count({
        where: {
          ...bugInTenant(tenantId),
          ...(projectId && !allProjects ? { projectId } : {}),
          isDeleted: false,
        },
      })) === 0;
    } catch {
      isFirstRun = false;
    }
  }

  // Only the watching view offers "stop watching the finished ones", and
  // only when there are some; everyone else pays for nothing (#312).
  let finishedWatched = 0;
  if (isWatchingView && userId) {
    try {
      finishedWatched = await prisma.bug.count({
        where: { ...finishedWatchedWhere(userId), ...bugInTenant(tenantId) },
      });
    } catch (error) {
      console.error("[bugs] finished watched count failed", error);
    }
  }

  // The current query string, which the status links build on.
  const currentQuery = new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) => {
      const single = toSingleQueryParam(v);
      return single ? [[k, single] as [string, string]] : [];
    }),
  ).toString();

  const confirmingCount = [...stages.values()].filter((stage) => stage === "confirming").length;
  const readyCount = [...stages.values()].filter((stage) => stage === "ready").length;

  const [statusCounts, rejectedCount, duplicateCount] = isDeletedView || !tenantId ? [[], 0, 0] : await Promise.all([
    loadOrEmpty("status tabs", () => prisma.bug.groupBy({
      by: ["status"], where: statusTabWhere, _count: { _all: true },
    }), []),
    loadOrEmpty("rejected filter", () => prisma.bug.count({
      where: { ...statusTabWhere, confirmations: REJECTED_WHERE },
    }), 0),
    loadOrEmpty("duplicate filter", () => prisma.bug.count({
      where: { ...statusTabWhere, duplicateOfId: { not: null } },
    }), 0),
  ]);
  // One status per issue, so the status tabs never overlap and add up to All.
  const countForStatus = (status: string) => statusCounts.find((row) => row.status === status)?._count._all ?? 0;
  const allCount = statusCounts.reduce((sum, row) => sum + row._count._all, 0);
  const allFilterCount = (value: string) =>
    value === ALL_STATUS ? allCount : value === REJECTED_STATUS ? rejectedCount : value === DUPLICATE_STATUS ? duplicateCount : countForStatus(value);
  // The All tab stays selected on its own filters (Closed, Rejected, Duplicates).
  const allSelected = ALL_FILTERS.some((filter) => filter.value === statusParam);
  const statusHref = (status: string | null) => {
    const next = new URLSearchParams(currentQuery);
    next.delete("page");
    next.delete("stage");
    next.delete(SHOW_RESOLVED_PARAM);
    next.delete(IDEAS_PARAM);
    if (status) next.set("status", status);
    else next.delete("status");
    return `/issues${next.size ? `?${next}` : ""}`;
  };
  // Only a status tab is picked (no search or other filter): an empty list then
  // just means that tab is empty, so the empty state names the tab.
  const onlyStatusTab =
    Boolean(statusParam && (statuses as readonly string[]).includes(statusParam)) &&
    !qParam && !tagsParam && !selectedPlatform && !selectedMilestone && !mineFilter;
  const emptyPlatform =
    Boolean(selectedPlatform) &&
    !isWatchingView &&
    !qParam &&
    !statusParam &&
    !tagsParam &&
    !selectedMilestone &&
    !selectedArea &&
    !stageView;

  // The stage the page is on, and the status inside it, for the stage bar and the list on the left.
  const currentStatus = ideasView === "rejected" ? REJECTED_IDEAS_STATUS : isIdeasView ? IDEAS_STATUS : statusParam;
  // Requires confirmation: the left column counts confirmations, and the importance votes sit at the end of the row.
  const confirmationsView = currentStatus === "requires_confirmation" && !isDeletedView;
  const stageIndex = isDeletedView ? -1 : STAGE_GROUPS.findIndex((group) => (group.statuses as readonly string[]).includes(currentStatus ?? ""));
  const statusCount = (value: string) =>
    value === IDEAS_STATUS ? ideasCount : value === REJECTED_IDEAS_STATUS ? rejectedIdeasCount : countForStatus(value);
  const statusLink = (value: string) => (value === IDEAS_STATUS ? statusHref(null) : statusHref(value));

  const headerContent = (
    <>
      {gettingStarted ? <GettingStarted {...gettingStarted} /> : null}
      {activeProject?.goal ? (
        <section aria-labelledby="project-goal-heading" className="rounded-[20px] border border-zk-border bg-zk-surface px-5 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="project-goal-heading" className="text-sm font-bold text-zk-text">{activeProject.name} goal</h2>
            {membershipRole && isOrganizationAdmin(membershipRole, effectiveRole) ? (
              <Link href={`/projects/${encodeURIComponent(activeProject.slug)}/settings`} className="text-xs font-bold text-zk-accent underline">Edit project settings</Link>
            ) : null}
          </div>
          <RichText content={activeProject.goal} className="mt-1 text-sm text-zk-text2" />
        </section>
      ) : null}
      <div className="issues-heading flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          {/* No visible title: the stages above say where you are. */}
          <h1 className="sr-only">{isDeletedView ? "Deleted Issues" : "Issues"}</h1>
          {isDeletedView || allProjects ? (
            <div className="flex flex-wrap items-center gap-2">
              {isDeletedView ? (
                <span className="rounded-md bg-zk-bad-bg px-2 py-0.5 text-[11px] font-bold text-zk-bad-fg">Admin view</span>
              ) : null}
              {allProjects && !isDeletedView ? (
                <span className="rounded-md border border-zk-border bg-zk-tint px-2 py-0.5 text-[11px] font-bold text-zk-accent">All projects</span>
              ) : null}
            </div>
          ) : null}
        </div>
        <Suspense fallback={<div className="h-8 w-36 rounded-lg bg-zk-chip" />}>
          <IssueFilters compact tagTypes={tagTypes} platforms={platforms} milestones={milestones} areas={areas} shortcutsEnabled={shortcutsEnabled}
            stageCounts={isDeletedView ? undefined : { confirming: confirmingCount, ready: readyCount }}
            trailing={isFirstRun ? null : (
              <>
                {/* Desktop: New issue is a + at the end of the search/filter row. */}
                {!isDeletedView ? <NewIssueButton className="max-md:hidden" /> : null}
              </>
            )} />
        </Suspense>
        <div className="issues-actions flex flex-wrap items-center gap-2 print:hidden">
          {finishedWatched > 0 ? <UnwatchFinishedButton count={finishedWatched} /> : null}
          <IssuesToolsToggle
            active={Boolean(searchText || selectedPlatform || selectedTags.length > 0 || selectedMilestone)}
          />
          {/* Phones: the + beside the title, since the tools row is collapsed there.
              Desktop uses the one in the tools row, unless that row has no platform menu yet. */}
          {!isDeletedView ? <NewIssueButton className={isFirstRun ? "" : "md:hidden"} /> : null}
        </div>
      </div>
    </>
  );

  const listContent = (
    <div className="space-y-4">

        {!isDeletedView && allSelected ? (
          <nav aria-label="Filter all issues" className="issues-all-filters flex flex-wrap items-center justify-end gap-1.5">
            <span className="mr-1 text-[13px] font-medium text-zk-muted">Filter by:</span>
            {ALL_FILTERS.map(({ value, label }) => {
              const on = statusParam === value;
              return (
                <Link
                  key={value}
                  href={statusHref(value)}
                  aria-current={on ? "page" : undefined}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zk-accent ${
                    on
                      ? "border-electric-blue-strong bg-electric-blue-strong text-white"
                      : "border-zk-border bg-zk-surface text-zk-text2 hover:text-zk-text"
                  }`}
                >
                  {label}
                  <span className={`font-mono text-[11px] tabular-nums ${on ? "text-white/80" : "text-zk-muted"}`}>{allFilterCount(value)}</span>
                </Link>
              );
            })}
          </nav>
        ) : null}

        {milestoneSummary ? (
          <section aria-label={`Milestone ${milestoneSummary.title}`} className="rounded-[20px] border border-zk-border bg-zk-surface p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-zk-text">{milestoneSummary.title}</h2>
              <MilestoneDue due={dueDateValue(milestoneSummary.dueDate) || null} isClosed={milestoneSummary.isClosed} />
              <Link href="/milestones" className="ml-auto text-sm font-bold text-zk-accent hover:underline">All milestones</Link>
            </div>
            {milestoneSummary.description ? <p className="mt-1 text-sm text-zk-muted">{milestoneSummary.description}</p> : null}
            <div className="mt-3 max-w-md">
              <MilestoneProgressBar progress={milestoneSummary.progress} label={milestoneSummary.title} />
            </div>
          </section>
        ) : null}

        {isIdeasView ? (
          <IdeasList
            ideas={ideaRows}
            empty={
              ideasView === "drafts"
                ? "No unstructured draft ideas are waiting to be structured."
                : ideasView === "rejected"
                  ? "No rejected ideas. A manager agent rejects a bad idea: one whose votes reach the threshold and whose bad and neutral votes outnumber its good ones."
                  : undefined
            }
          />
        ) : isFirstRun ? (
          <FirstRunWelcome isAdmin={canDelete} hasTenant={Boolean(tenantId)} />
        ) : bugs.length === 0 ? (
          <WhimsicalEmptyState
            title={
              isWatchingView && !qParam && !statusParam && !tagsParam && !selectedPlatform && !selectedMilestone
                ? "You're not watching any issues."
                : emptyPlatform
                  ? "No issues on this platform"
                  : onlyStatusTab
                    ? `No issues in ${statusFilterLabel(statusParam!)}.`
                    : "No issues match these filters."
            }
            description={
              isWatchingView
                ? "You watch issues you report, are assigned to or comment on, and any you choose to watch from the issue page."
                : emptyPlatform
                  ? "Issues tagged for this platform will show up here."
                  : onlyStatusTab
                    ? undefined
                    : "Maybe the bugs went into hiding, or they've all been squashed! Try clearing your filters or create a new issue."
            }
            clearHref="/issues"
            createHref="/issues/new"
            showClear={Boolean(!onlyStatusTab && (qParam || statusParam || tagsParam || selectedPlatform || selectedMilestone))}
            showCreate={true}
          />
        ) : (
          <section className="issues-results flex flex-col gap-3.5">
            <div className="issues-results-summary flex flex-wrap items-baseline justify-between gap-2.5">
              <div className="flex flex-wrap items-baseline gap-2.5">
                <h2 className="text-lg font-bold text-zk-text">All issues</h2>
                <p role="status" aria-live="polite" className="text-[13px] text-zk-muted">
                  {/* Not shown on screen (the tabs carry the counts), but still announced when the results change. */}
                  <span className="sr-only">
                    {resultCountText(totalCount, statusWhere !== undefined ? statusParam ?? null : null)}, sorted by{" "}
                    {bugSortDescriptions[currentSort]}
                  </span>
                  {hiddenDuplicates > 0 || showDuplicates ? (
                    <>
                      <Link href={duplicatesHref} className="font-bold text-zk-accent hover:underline print:hidden">
                        {showDuplicates ? "Hide duplicates" : `Show ${hiddenDuplicates} duplicate${hiddenDuplicates === 1 ? "" : "s"}`}
                      </Link>
                    </>
                  ) : null}
                </p>
              </div>
            </div>

            <div className="issues-table relative">
              <div>
                <div className="issues-table-heading">
                  {confirmationsView ? (
                    <abbr className="w-[52px] no-underline" title="Confirmations">Conf.</abbr>
                  ) : (
                    <span className="w-[76px] shrink-0 text-center">Importance</span>
                  )}
                  <span className="min-w-0 flex-1">Issue</span>
                  <span className="issues-status-cell">Status</span>
                  {confirmationsView ? <span className="issues-vote-end">Importance</span> : null}
                  <span className="w-10" aria-hidden="true" />
                </div>
                <ul>
                  {bugs.map((bug, index) => {
                    const stage = stages.get(bug.id);
                    const typeName = bug.type?.name ?? "—";
                    const isSecurity = /security/i.test(typeName);
                    const isFeature = !isSecurity && /feature|improve|enhance|request|idea/i.test(typeName);
                    const claim = bug.claims?.find((c) => c.status === "active");
                    const offer = bug.claims?.find((c) => c.status === "offered");
                    // Someone is on it: an active claim, or the issue was moved to in progress.
                    const work = claim || bug.status === "in_progress"
                      ? { person: claim?.beneficiary?.name ?? bug.assignee?.name ?? null, since: claim ? (claim.claimedAt ?? claim.createdAt) : null }
                      : null;
                    // Importance in a list is a number to read, not a button: it is marked on the issue's page.
                    const importance = <CountBadge value={bug.voteCount} label={`Importance ${bug.voteCount}`} testId="importance-count" />;
                    const rowStatus = (
                      <IssueRowStatus status={bug.status} stage={stage} botConfirmations={confirmationCounts.get(bug.id) ?? 0} work={work}
                        closeReason={bug.closeReason}
                        confirmed={confirmationStates.get(bug.id)?.confirmed ?? false}
                        bids={bug.status === "open" ? bug._count.bids : undefined}
                        offeredTo={bug.status === "open" && offer ? (offer.beneficiary?.name ?? "someone") : null}
                        mergePath={bug.status === "resolved" && bug.pullRequestUrl ? mergePathOf(bug) : null} />
                    );

                    return (
                      <li
                        key={bug.id}
                        className={`issues-row flex items-center gap-2 px-2 py-3.5 lg:gap-4 lg:px-4 ${
                          index < bugs.length - 1 ? "border-b border-zk-divider" : ""
                        }`}
                      >
                        {confirmationsView ? (
                          <div className="w-[52px] shrink-0">
                            <ConfirmationCountBadge {...(confirmationStates.get(bug.id) ?? { accepts: 0, needed: 0, confirmed: false })} />
                          </div>
                        ) : (
                          <div className="issues-vote w-[76px] shrink-0">{importance}</div>
                        )}
                        <Link
                          href={issuePath(bug.number)}
                          data-issue-link=""
                          className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md text-left [touch-action:manipulation] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-electric-blue"
                        >
                          <span
                            data-issue-type-icon=""
                            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                              isSecurity ? "bg-zk-bad-bg text-zk-bad-fg" : "bg-zk-tint text-zk-accent"
                            }`}
                            aria-hidden="true"
                          >
                            {isSecurity ? (
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
                            ) : (
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={BUG_ICON_PATH} /></svg>
                            )}
                          </span>
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className={`issues-row-title text-sm font-semibold leading-snug ${isDone(bug.status) ? "text-zk-muted" : "text-zk-text"}`}>
                              {searchText ? (
                                <Highlighted segments={highlightSegments(bug.title, searchText)} />
                              ) : (
                                bug.title
                              )}
                            </span>
                            <span className="issues-row-meta flex items-center gap-2 text-xs text-zk-muted">
                              <span className="font-mono tabular-nums">{formatIssueNumber(bug.number)}</span>
                              {/* The type, as a small icon: bug, feature or security. */}
                              <span className="inline-flex items-center" title={typeName}>
                                <span className="sr-only">{typeName}</span>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d={isSecurity ? "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" : isFeature ? FEATURE_ICON_PATH : BUG_ICON_PATH} />
                                </svg>
                              </span>
                              {(bug._count?.comments ?? 0) > 0 ? (
                                <span className="inline-flex items-center gap-1" title={`Conversation: ${bug._count?.comments}`}>
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                                  {bug._count?.comments}
                                </span>
                              ) : null}
                              {(bug._count?.attachments ?? 0) > 0 ? (
                                <span title={`${bug._count?.attachments} attachments`}>📎 {bug._count?.attachments}</span>
                              ) : null}
                              {bug.isDeleted ? <span className="font-bold text-zk-bad-fg">Deleted</span> : null}
                              {bug.duplicateOf ? (
                                <span>Duplicate of {formatIssueNumber(bug.duplicateOf.number)}</span>
                              ) : null}
                              {bug.category ? <span>{bug.category.name}</span> : null}
                              <RowAge date={currentSort === "newest" ? bug.createdAt : bug.updatedAt} sort={currentSort === "newest" ? "newest" : "updated"} />
                              {/* Below md (768px) the status column is hidden, so the status rides at the end of this line. */}
                              <span className="inline-flex min-w-0 md:sr-only">{rowStatus}</span>
                            </span>
                            {snippets.has(bug.id) ? <SearchSnippet snippet={snippets.get(bug.id)!} /> : null}
                          </span>
                        </Link>
                        <span className="issues-status-cell" aria-hidden="true">{rowStatus}</span>
                        {confirmationsView ? (
                          <div className="issues-vote issues-vote-end shrink-0">{importance}</div>
                        ) : null}
                        <span
                          className={`w-10 shrink-0 items-center justify-end gap-2 ${
                            isWatchingView && !bug.isDeleted ? "flex" : "hidden lg:flex"
                          }`}
                        >
                          {bug.assignee ? (
                            <span className="hidden lg:inline-flex">
                              <RowAssignee name={bug.assignee.name} image={bug.assignee.image} />
                            </span>
                          ) : bug.reporter ? (
                            <span className="hidden lg:inline-flex" title={`Reported by ${bug.reporter.name}`}>
                              <Avatar name={bug.reporter.name} image={bug.reporter.image} size="sm" />
                              <span className="sr-only">Reported by {bug.reporter.name}</span>
                            </span>
                          ) : null}
                          {isWatchingView && !bug.isDeleted ? (
                            <UnwatchButton bugId={bug.id} label={`${formatIssueNumber(bug.number)} ${bug.title}`} />
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>

            <PaginationControls
              page={pagination.page}
              totalPages={pagination.totalPages}
              totalCount={totalCount}
              from={pagination.from}
              to={pagination.to}
              queryParams={issueListPaginationParams({
                status: statusParam,
                mine: mineFilter,
                q: qParam,
                sort: sortParam,
                milestone: milestoneParam,
                tags: tagsParam,
                platform: selectedPlatform,
                area: selectedArea,
                stage: stageView,
                deleted: isDeletedView,
                showDuplicates,
                showResolved,
                allProjects,
              })}
            />
          </section>
        )}
      </div>
  );

  return (
    <>
    {/* An issue's back arrow returns here, to this tab, filters and page. */}
    <Suspense fallback={null}>
      <RememberIssueList />
    </Suspense>
    {/* The stages, centred, with Project notes at the right of the same row. */}
    <div className="relative mx-auto mb-4 flex min-h-8 w-full max-w-6xl items-start justify-center">
      {!isDeletedView ? (
        <PipelineSteps
          stages={STAGE_GROUPS.map((group, index) => ({
            label: group.label,
            count: group.statuses.reduce((sum, value) => sum + statusCount(value), 0),
            href: statusLink(group.statuses[0]),
            selected: index === stageIndex,
          }))}
        />
      ) : null}
      <div className="absolute right-0 top-0 flex items-center gap-2">
        <ProjectNotesLink />
        <PlatformMenu
          iconOnly
          tabs={platformTabs.map((tab) => ({ ...tab, href: platformHref(tab.id) }))}
          current={selectedPlatform}
        />
      </div>
    </div>
    <div className="issues-page mx-auto w-full max-w-6xl space-y-5">
      {headerContent}
      <div className="flex items-start gap-5 max-lg:flex-col max-lg:gap-3">
        {stageIndex >= 0 ? (
          <StageSidebar
            steps={STAGE_GROUPS[stageIndex].statuses.map((value) => ({
              label: value === IDEAS_STATUS ? "New ideas" : value === REJECTED_IDEAS_STATUS ? "Rejected ideas" : statusFilterLabel(value),
              count: statusCount(value),
              href: statusLink(value),
              selected: value === currentStatus,
            }))}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          {listContent}
        </div>
      </div>
    </div>
    </>
  );
}


/** What a brand-new tracker shows instead of an empty list (#292, #444). */
function FirstRunWelcome({
  isAdmin,
  hasTenant = true,
}: {
  isAdmin: boolean;
  hasTenant?: boolean;
}) {
  if (!hasTenant) {
    return (
      <section aria-labelledby="issues-workspace-heading" className="issues-workspace-empty rounded-[20px] border border-zk-border bg-zk-bg px-6 py-10 text-center sm:px-8">
        <h2 id="issues-workspace-heading" className="text-xl font-bold leading-7 text-zk-text">No workspace yet</h2>
        <p className="mx-auto mt-3 max-w-lg text-base leading-7 text-zk-text2">
          You are not currently a member of any workspace. Join a workspace via an invite from your team,
          or create your own workspace to start filing issues.
        </p>
        <div className="mt-6">
          <Link
            href="/tenants"
            className="inline-flex min-h-12 max-w-full items-center justify-center rounded-full bg-electric-blue-strong px-6 py-3 text-sm font-bold leading-5 text-white transition-colors hover:bg-blue-slate focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-zk-accent"
          >
            Create or join a workspace
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-[20px] border border-zk-border bg-zk-surface px-5 py-8 text-center">
      <h2 className="text-lg font-bold text-zk-text">No issues yet</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-zk-muted">
        This is where reported issues will appear. A good report says what you
        expected, what happened instead, and how to make it happen again.
      </p>
      <div className="mt-5">
        <Link
          href={newIssueHref("/issues")}
          className="inline-flex h-[42px] items-center justify-center rounded-full bg-electric-blue-strong px-5 text-sm font-bold text-white shadow-[0_8px_20px_rgba(46,111,239,0.35)]"
        >
          Report the first issue
        </Link>
      </div>
      {isAdmin ? (
        <p className="mx-auto mt-6 max-w-md text-sm text-zk-muted">
          Before people start reporting, you may want to set up your{" "}
          <Link href="/projects" className="font-bold text-zk-accent underline">projects</Link>
          , and the{" "}
          <Link href="/admin/categories" className="font-bold text-zk-accent underline">platforms</Link>{" "}
          and{" "}
          <Link href="/admin/types" className="font-bold text-zk-accent underline">issue types</Link>{" "}
          they will choose from.
        </p>
      ) : null}
    </section>
  );
}
