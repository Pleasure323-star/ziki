import Link from "next/link";
import { newIssueHref } from "@/lib/reported-from";
import "./issues.css";
import { Avatar } from "@/components/avatar";
import { Suspense } from "react";
import type { Prisma, Severity } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getIssueTypes, getPlatforms } from "@/lib/lookups";
import { activeBulkOptions, loadBulkAssignees } from "@/lib/admin-list-lookups";
import { auth } from "@/auth";
import { requireUser } from "@/lib/auth-helpers";
import { InboxButton } from "@/components/inbox-button";
import { MergeIcon } from "@/components/merge-path";
import { InboxAgents } from "@/components/inbox-agents";
import { loadOwnAgents, type DashboardAgent } from "@/lib/dashboard-overview";
import { agentWorkDone, describeWorkDone, type AgentWorkDone } from "@/lib/agent-work";
import type { AppRole } from "@/lib/roles";
import { IssueFilters } from "@/components/issue-filters";
import { RowAge, RowAssignee } from "@/components/issue-row-meta";
import { VoteButton } from "@/components/vote-button";
import { IdeasList, type IdeaListRow } from "@/components/ideas-list";
import { workflowFor } from "@/lib/workflow";
import { severityLabels } from "@/lib/labels";
import { severities } from "@/lib/validations/issue";
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
  defaultStatusWhere,
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
import { fetchVoterSummaries } from "@/lib/voter-summaries";
import { dueDateValue, MILESTONE_PARAM, milestoneParamValue, milestoneWhere, parseMilestoneFilter } from "@/lib/milestones";
import { loadMilestoneSummaries } from "@/lib/milestone-stats";
import { MilestoneProgressBar } from "@/components/milestone-progress";
import { MilestoneDue } from "@/components/milestone-due";
import { createEmptyVoterSummary } from "@/lib/voters";
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
import {
  BulkCheckbox,
  BulkSelectionProvider,
} from "@/components/bulk-selection";
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
import { IssueRowStatus } from "@/components/issue-row-status";
import { mergePathOf } from "@/lib/merge-history";
import { IssueRowStageTallies } from "@/components/issue-row-stage-tallies";
import { claimDecisionKind, payloadMerged, tallyStages, type DecisionLike, type StageTallies } from "@/lib/decision-stages";
import { IssuesToolsToggle } from "@/components/issues-tools-toggle";
import { LoadError } from "@/components/load-error";
import { logLoadFailure } from "@/lib/load-error";
import { AREA_PARAM, parseProjectAreaFilter, projectAreaFilterWhere } from "@/lib/project-area-filter";
import { openIssueStages, parseIssueStageView, type IssueStage } from "@/lib/issue-stage";
import { voteDirection } from "@/lib/voting";
import { issuePath } from "@/lib/issue-ref";
import { PROJECT_ALL_PARAM, showsAllProjects } from "@/lib/issue-list-filters";

/* Distinct browser-tab title; the root layout appends "· Ziki". */
export const metadata = { title: "Issues" };

/** `?status=all`: every issue. With no `?status=` the page opens on the Inbox. */
const ALL_STATUS = "all";
/** `?status=escalated`: the Inbox; kept so older links still open it. */
const ESCALATED_STATUS = "escalated";
const ESCALATED_WHERE = { some: { answeredAt: null } } satisfies Prisma.AgentQuestionListRelationFilter;

/**
 * The Inbox's three lists, picked with `?inbox=` on the escalated view:
 * agent questions waiting on someone (the default), redesign proposals
 * waiting on a decision, and new ideas (reported, not yet confirmed).
 */
const INBOX_PARAM = "inbox";
type InboxView = "input" | "design";
const INBOX_TABS: { view: InboxView; label: string }[] = [
  { view: "input", label: "Need your input" },
  { view: "design", label: "Design feedback needed" },
];
/** `?status=ideas`: the Ideas tab. Ideas are not issues and come from their own table (#idea-table). */
const IDEAS_STATUS = "ideas";
/** Most ideas the tab lists, highest score first. */
const IDEAS_LIMIT = 100;
const DESIGN_WHERE = { some: { status: "proposed" } } satisfies Prisma.RedesignProposalListRelationFilter;
const AGENT_ORDER = { waiting: 0, working: 1, idle: 2, offline: 3 } as const;

/** `?status=rejected`: a reviewer agent found the issue isn't real (#1122). */
const REJECTED_STATUS = "rejected";
const REJECTED_WHERE = { some: { kind: "real", verdict: "reject" } } satisfies Prisma.IssueValidationListRelationFilter;
/** `?status=duplicate`: marked as a duplicate of another issue. */
const DUPLICATE_STATUS = "duplicate";
/**
 * `?status=ready_to_merge`: accepted fixes waiting for a merger agent (#SDLC).
 * Accepting a fix leaves the issue open or in progress, so the tab takes any
 * status but closed, and Open and In progress leave these out.
 */
const READY_TO_MERGE_STATUS = "ready_to_merge";
/** `?status=auto_merge`: resolved issues whose fix is live — merged to dev, staging, main/production (#SDLC). */
const AUTO_MERGE_STATUS = "auto_merge";
/**
 * `?status=resolved`: the Done tab (Ziki #713). A pull request is linked and
 * the project's required independent reviewers said it is good to merge
 * (review status `tested`). It follows the work, not a status a person set:
 * Open and In progress leave these out, as they do for Ready to Merge.
 */
const DONE_STATUS = "resolved";
/** Statuses an accepted fix can have while it waits to be merged. */
const READY_TO_MERGE_STATUSES = ["open", "in_progress", "resolved"] as const;

/** The filters under the All tab. Open, In progress and Done have tabs of their own. */
const ALL_FILTERS = [ALL_STATUS, "closed", REJECTED_STATUS, DUPLICATE_STATUS].map((value) => ({
  value,
  label: statusFilterLabel(value),
}));
/** The status tabs, left to right. */
const STATUS_TABS = [IDEAS_STATUS, "open", "in_progress", DONE_STATUS, READY_TO_MERGE_STATUS, AUTO_MERGE_STATUS, ALL_STATUS].map((value) => ({
  value,
  label: statusFilterLabel(value),
}));

/** New issue as a 32px + button; the name is kept for screen readers and the tooltip. */
function NewIssueButton({ className = "" }: { className?: string }) {
  return (
    <Link
      href={newIssueHref("/issues")}
      title="New issue"
      className={`issues-new inline-flex w-8 items-center justify-center rounded-lg border border-zk-border bg-zk-surface text-zk-text hover:bg-zk-chip ${className}`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      <span className="sr-only">New issue</span>
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
  severity?: string | string[];
  platform?: string | string[];
  area?: string | string[];
  sort?: string | string[];
  page?: string | string[];
  deleted?: string | string[];
  mine?: string | string[];
  tags?: string | string[];
  [key: string]: string | string[] | undefined;
}>;

function isSeverity(value: string | undefined): value is Severity {
  return !!value && (severities as readonly string[]).includes(value);
}

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
  // The breadcrumb's first crumb ("Zedu › Issues").
  const workspaceName = tenantId
    ? await loadOrEmpty("workspace name", async () => (await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }))?.name ?? null, null)
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
  // No ?status= opens the Inbox (the escalated view); ?status=all is the All tab.
  // A search with no tab picked looks across All, so any issue can be found.
  const statusParam =
    toSingleQueryParam(params.status) ??
    (toSingleQueryParam(params.deleted) === "true" ? undefined : toSingleQueryParam(params.q)?.trim() ? ALL_STATUS : ESCALATED_STATUS);
  const severityParam = toSingleQueryParam(params.severity);
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
  // With no status filter the All tab shows every issue, finished ones too;
  // Open, In progress and Done are tabs of their own. Inbox (escalated) keeps
  // to live work unless resolved issues were asked for (#1058).
  const showResolved = parseShowResolved(params[SHOW_RESOLVED_PARAM]);
  const hidesResolved = statusParam === ESCALATED_STATUS && !isDeletedView && !showResolved;
  if (statusWhere !== undefined) {
    where.status = statusWhere;
    // An accepted fix waiting to be merged is on the Ready to Merge tab instead.
    if ((statusParam === "open" || statusParam === "in_progress") && !isDeletedView) {
      where.AND = [{ OR: [{ reviewStatus: null }, { reviewStatus: { not: "ready_to_merge" } }] }];
    }
    // A tested fix (two good-to-merge verdicts) is on the Done tab instead (Ziki #713).
    if ((statusParam === "open" || statusParam === "in_progress") && !isDeletedView) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        { OR: [{ reviewStatus: null }, { reviewStatus: { not: "tested" } }] },
      ];
    }
  } else if (hidesResolved) {
    where.status = defaultStatusWhere(false);
  }
  // The Escalated tab: live issues with an agent question nobody has
  // answered, the same rule as the Escalations page.
  const isEscalatedView = statusParam === ESCALATED_STATUS && !isDeletedView;
  const inboxParam = toSingleQueryParam(params[INBOX_PARAM]);
  const inboxView: InboxView | null = !isEscalatedView
    ? null
    : inboxParam === "design"
      ? inboxParam
      : "input";
  if (inboxView === "input") {
    where.agentQuestions = ESCALATED_WHERE;
  } else if (inboxView === "design") {
    where.redesigns = DESIGN_WHERE;
  }
  // The Ideas tab lists the Idea table, not issues: no issue row matches it.
  const isIdeasView = statusParam === IDEAS_STATUS && !isDeletedView;
  if (isIdeasView) where.id = { in: [] };
  if (statusParam === REJECTED_STATUS && !isDeletedView) {
    where.validations = REJECTED_WHERE;
  }
  if (statusParam === DUPLICATE_STATUS && !isDeletedView) {
    where.duplicateOfId = { not: null };
  }
  if (statusParam === READY_TO_MERGE_STATUS && !isDeletedView) {
    where.status = { in: [...READY_TO_MERGE_STATUSES] };
    where.reviewStatus = "ready_to_merge";
  }
  if (statusParam === AUTO_MERGE_STATUS && !isDeletedView) {
    where.status = "resolved";
    where.reviewStatus = "merged";
  }
  if (statusParam === DONE_STATUS && !isDeletedView) {
    where.status = { in: [...READY_TO_MERGE_STATUSES] };
    where.reviewStatus = "tested";
  }
  if (isSeverity(severityParam)) {
    where.severity = severityParam;
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
  if (!isDeletedView) {
    try {
      stages = await openIssueStages(prisma, where);
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
  // its status, and the extra clauses the Inbox lists, Rejected, Duplicates,
  // Ready to Merge and Live add. Left in, those leaked into every other tab's
  // count (on Ready to Merge, "All" only counted ready-to-merge issues).
  const {
    status: _selectedStatus,
    id: _stageIds,
    agentQuestions: _escalated,
    validations: _rejected,
    duplicateOfId: _duplicate,
    redesigns: _design,
    reviewStatus: _review,
    AND: _notMergeStage,
    ...tabScope
  } = where;
  // Put the default duplicate scope back: the Duplicates filter's override is
  // dropped, but tabs and counts still leave out the duplicates the list hides.
  const statusTabWhere: Prisma.BugWhereInput = { ...tabScope, ...duplicatesWhere(showDuplicates) };
  void _design;
  void _selectedStatus;
  void _stageIds;
  void _escalated;
  void _rejected;
  void _duplicate;
  void _review;
  void _notMergeStage;
  // The platform menu counts each platform's issues whatever tab is picked,
  // so its numbers don't move as you switch tabs; the tabs then split the
  // picked platform's total. (Counting inside the Inbox showed 0 almost
  // everywhere.) A ?stage= from the URL still narrows it (#626).
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
      if (isEscalatedView && (key === INBOX_PARAM || key === SHOW_RESOLVED_PARAM)) continue;
      const single = toSingleQueryParam(value);
      if (single) next.set(key, single);
    }
    if (isEscalatedView) next.set("status", ALL_STATUS);
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
        severity: true,
        voteCount: true,
        projectId: true,
        isDeleted: true,
        isBoosted: true,
        duplicateOf: showDuplicates ? { select: { number: true } } : false,
        createdAt: true,
        updatedAt: true,
        // A merged fix shows its dev → staging → main chips in the status column.
        reviewStatus: true,
        pullRequestUrl: true,
        type: { select: { name: true } },
        reporter: { select: { name: true, role: true, image: true } },
        assignee: { select: { name: true, role: true, image: true } },
        // Who is working on it and since when, for the status column.
        claims: {
          where: { status: "active", releasedAt: null },
          select: { claimedAt: true, createdAt: true, beneficiary: { select: { name: true } } },
          take: 1,
        },
        category: { select: { id: true, name: true } },
        area: { select: { id: true, name: true } },
        votes: userId
          ? { where: { userId }, select: { id: true, value: true }, take: 1 }
          : false,
        _count: {
          select: {
            comments: true,
            attachments: true,
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

  // #idea-table: the Ideas tab reads open ideas from their own table, in the
  // same tenant, project and search scope as the issues.
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
  const ideasCount = tenantId && !isDeletedView ? await loadOrEmpty("ideas tab", () => prisma.idea.count({ where: ideaWhere }), 0) : 0;
  const ideaRows: IdeaListRow[] = isIdeasView && tenantId
    ? await loadOrEmpty("ideas list", async () => {
        const rows = await prisma.idea.findMany({
          where: ideaWhere,
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

  const bugIds = bugs.map((bug) => bug.id);

  // "Confirmed (3)": how many bots (reviewer agents) accepted each issue as real.
  const botConfirmations = new Map(
    (bugIds.length === 0 ? [] : await loadOrEmpty("bot confirmations", () => prisma.issueValidation.groupBy({
      by: ["bugId"],
      where: { bugId: { in: bugIds }, kind: "real", verdict: "accept" },
      _count: { _all: true },
    }), [])).map((row) => [row.bugId, row._count._all] as const),
  );

  // #1446: positive and negative agent decisions per stage, for the card's
  // stage strip. Same rules as the issue page (lib/decision-stages.ts).
  const stageTallies = new Map<string, StageTallies>();
  if (bugIds.length > 0) {
    const [validationRows, verdictRows, claimRows, auditRows] = await Promise.all([
      loadOrEmpty("stage validations", () => prisma.issueValidation.groupBy({
        by: ["bugId", "verdict"],
        where: { bugId: { in: bugIds }, kind: "real" },
        _count: { _all: true },
      }), []),
      loadOrEmpty("stage verdicts", () => prisma.testVerdict.groupBy({
        by: ["bugId", "goodToMerge"],
        where: { bugId: { in: bugIds } },
        _count: { _all: true },
      }), []),
      loadOrEmpty("stage claims", () => prisma.issueClaim.groupBy({
        by: ["bugId", "status", "releaseReason"],
        where: { bugId: { in: bugIds }, claimedAt: { not: null } },
        _count: { _all: true },
      }), []),
      loadOrEmpty("stage merges", () => prisma.agentAuditEvent.findMany({
        where: { bugId: { in: bugIds }, action: { in: ["issue.accepted", "issue.merge_rejected", "github.merge_failed"] } },
        select: { bugId: true, action: true, payload: true, agent: { select: { level: true } } },
      }), []),
    ]);
    const rows = new Map<string, (DecisionLike & { count?: number })[]>();
    const add = (bugId: string | null, row: DecisionLike & { count?: number }) => {
      if (bugId) rows.set(bugId, [...(rows.get(bugId) ?? []), row]);
    };
    for (const r of validationRows) add(r.bugId, { kind: r.verdict === "reject" ? "rejected" : "confirmed", count: r._count._all });
    for (const r of verdictRows) add(r.bugId, { kind: "verdict", goodToMerge: r.goodToMerge, count: r._count._all });
    for (const r of claimRows) {
      // The query already kept only claims that were taken up (claimedAt set).
      const kind = claimDecisionKind({ status: r.status, claimedAt: "set", releaseReason: r.releaseReason });
      if (kind) add(r.bugId, { kind, count: r._count._all });
    }
    for (const e of auditRows) {
      const merger = e.agent.level === "manager" || e.agent.level === "merger";
      if (e.action === "issue.accepted") add(e.bugId, { kind: "accepted", merged: payloadMerged(e.payload) });
      else if (merger) add(e.bugId, { kind: e.action === "issue.merge_rejected" ? "merge_rejected" : "deploy_failed" });
    }
    for (const [bugId, bugRows] of rows) stageTallies.set(bugId, tallyStages(bugRows));
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

  // Only admins get bulk actions. The type and platform menus reuse the
  // lookups above, which already survived a missing table. The assignee
  // query is the one extra read, and it must not take the list down either.
  const bulkTypes = canDelete ? activeBulkOptions(tagTypes) : [];
  const bulkPlatforms = canDelete ? activeBulkOptions(platforms) : [];
  const bulkUsers = canDelete ? await loadBulkAssignees(tenantId) : [];

  let voterSummaries = new Map<string, ReturnType<typeof createEmptyVoterSummary>>();
  try {
    voterSummaries = await fetchVoterSummaries(bugIds);
  } catch (error) {
    console.error("[bugs] voter summaries failed", error);
    voterSummaries = new Map();
  }

  // The key is the current query string, so changing a filter or a page
  // remounts the provider and clears the selection — which is what the bar
  // tells the user will happen.
  const selectionKey = new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) => {
      const single = toSingleQueryParam(v);
      return single ? [[k, single] as [string, string]] : [];
    }),
  ).toString();

  const confirmingCount = [...stages.values()].filter((stage) => stage === "confirming").length;
  const readyCount = [...stages.values()].filter((stage) => stage === "ready").length;

  const [statusCounts, escalatedCount, rejectedCount, duplicateCount, readyToMergeByStatus, liveCount, testedByStatus] = isDeletedView || !tenantId ? [[], 0, 0, 0, [], 0, []] : await Promise.all([
    loadOrEmpty("status tabs", () => prisma.bug.groupBy({
      by: ["status"], where: statusTabWhere, _count: { _all: true },
    }), []),
    loadOrEmpty("escalated tab", () => prisma.bug.count({
      where: { ...statusTabWhere, status: defaultStatusWhere(false), agentQuestions: ESCALATED_WHERE },
    }), 0),
    loadOrEmpty("rejected filter", () => prisma.bug.count({
      where: { ...statusTabWhere, validations: REJECTED_WHERE },
    }), 0),
    loadOrEmpty("duplicate filter", () => prisma.bug.count({
      where: { ...statusTabWhere, duplicateOfId: { not: null } },
    }), 0),
    loadOrEmpty("ready to merge tab", () => prisma.bug.groupBy({
      by: ["status"],
      where: { ...statusTabWhere, status: { in: [...READY_TO_MERGE_STATUSES] }, reviewStatus: "ready_to_merge" },
      _count: { _all: true },
    }), []),
    loadOrEmpty("live tab", () => prisma.bug.count({
      where: { ...statusTabWhere, status: "resolved", reviewStatus: "merged" },
    }), 0),
    loadOrEmpty("done tab", () => prisma.bug.groupBy({
      by: ["status"],
      where: { ...statusTabWhere, status: { in: [...READY_TO_MERGE_STATUSES] }, reviewStatus: "tested" },
      _count: { _all: true },
    }), []),
  ]);
  const readyToMergeFor = (status: string) => readyToMergeByStatus.find((row) => row.status === status)?._count._all ?? 0;
  const readyToMergeCount = READY_TO_MERGE_STATUSES.reduce((sum, status) => sum + readyToMergeFor(status), 0);
  // Open and In progress leave out what waits on the Ready to Merge tab, so the tabs never overlap.
  const countForStatus = (status: string) =>
    (statusCounts.find((row) => row.status === status)?._count._all ?? 0) -
    (status === "open" || status === "in_progress" ? readyToMergeFor(status) : 0);
  const allCount = statusCounts.reduce((sum, row) => sum + row._count._all, 0);
  // Done is the tested fixes (Ziki #713); Open and In progress leave them out too.
  const testedFor = (status: string) => testedByStatus.find((row) => row.status === status)?._count._all ?? 0;
  const doneCount = READY_TO_MERGE_STATUSES.reduce((sum, status) => sum + testedFor(status), 0);
  const workTabCount = (status: string) =>
    countForStatus(status) - (status === "open" || status === "in_progress" ? testedFor(status) : 0);
  const tabCount = (value: string) =>
    value === ALL_STATUS ? allCount
      : value === IDEAS_STATUS ? ideasCount
      : value === DONE_STATUS ? doneCount
        : value === "open" || value === "in_progress" ? workTabCount(value)
        : value === READY_TO_MERGE_STATUS ? readyToMergeCount
          : value === AUTO_MERGE_STATUS ? liveCount
            : countForStatus(value);
  const allFilterCount = (value: string) =>
    value === ALL_STATUS ? allCount : value === REJECTED_STATUS ? rejectedCount : value === DUPLICATE_STATUS ? duplicateCount : value === READY_TO_MERGE_STATUS ? readyToMergeCount : countForStatus(value);
  // The Inbox's other lists, counted only while it is open.
  const liveTabWhere = { ...statusTabWhere, status: defaultStatusWhere(false) };
  const designCount = inboxView && tenantId
    ? await loadOrEmpty("design inbox", () => prisma.bug.count({ where: { ...liveTabWhere, redesigns: DESIGN_WHERE } }), 0)
    : 0;
  const inboxCounts: Record<InboxView, number> = { input: escalatedCount, design: designCount };
  // Your agents and what they've done, for the right half of the Inbox's top box.
  let inboxAgents: DashboardAgent[] = [];
  let inboxWork = new Map<string, AgentWorkDone>();
  if (inboxView && userId && tenantId) {
    inboxAgents = await loadOrEmpty("inbox agents", () => loadOwnAgents({ userId, tenantId }), [] as DashboardAgent[]);
    inboxWork = await loadOrEmpty("inbox agent work", () => agentWorkDone(inboxAgents.map((agent) => agent.id)), new Map<string, AgentWorkDone>());
  }
  const inboxHref = (view: InboxView) => {
    // The Inbox is the page with no ?status=.
    const next = new URLSearchParams(statusHref(null).split("?")[1] ?? "");
    if (view !== "input") next.set(INBOX_PARAM, view);
    return `/issues${next.size ? `?${next}` : ""}`;
  };
  // The All tab stays selected on its own filters (Closed, Rejected, Duplicates).
  const allSelected = ALL_FILTERS.some((filter) => filter.value === statusParam);
  const statusHref = (status: string | null) => {
    const next = new URLSearchParams(selectionKey);
    next.delete("page");
    next.delete("stage");
    next.delete(SHOW_RESOLVED_PARAM);
    next.delete(INBOX_PARAM);
    if (status) next.set("status", status);
    else next.delete("status");
    return `/issues${next.size ? `?${next}` : ""}`;
  };
  const emptyPlatform =
    Boolean(selectedPlatform) &&
    !isWatchingView &&
    !qParam &&
    !statusParam &&
    !severityParam &&
    !tagsParam &&
    !selectedMilestone &&
    !selectedArea &&
    !stageView;

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
          {/* A thin breadcrumb row, "Zedu › Issues", in place of a big title. */}
          <nav aria-label="Breadcrumb" className="issues-breadcrumb flex min-w-0 flex-wrap items-center gap-2">
            {workspaceName ? (
              <>
                <Link href="/dashboard" className="truncate text-zk-text2 hover:text-zk-text">{workspaceName}</Link>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-zk-muted"><path d="m9 18 6-6-6-6" /></svg>
              </>
            ) : null}
            <h1 aria-current="page" className="text-zk-text">
              {isDeletedView ? "Deleted Issues" : "Issues"}
            </h1>
            {isDeletedView ? (
              <span className="rounded-md bg-zk-bad-bg px-2 py-0.5 text-[11px] font-bold text-zk-bad-fg">Admin view</span>
            ) : null}
            {allProjects && !isDeletedView ? (
              <span className="rounded-md border border-zk-border bg-zk-tint px-2 py-0.5 text-[11px] font-bold text-zk-accent">All projects</span>
            ) : null}
          </nav>
        </div>
        <Suspense fallback={<div className="h-8 w-36 rounded-lg bg-zk-chip" />}>
          <IssueFilters compact tagTypes={tagTypes} platforms={platforms} milestones={milestones} areas={areas} shortcutsEnabled={shortcutsEnabled}
            stageCounts={isDeletedView ? undefined : { confirming: confirmingCount, ready: readyCount }}
            trailing={isFirstRun ? null : (
              <>
                {/* Desktop: New issue is a + just left of the platform menu, which stays rightmost. */}
                {!isDeletedView ? <NewIssueButton className="max-md:hidden" /> : null}
                <PlatformMenu
                  compact
                  tabs={platformTabs.map((tab) => ({ ...tab, href: platformHref(tab.id) }))}
                  current={selectedPlatform}
                />
              </>
            )} />
        </Suspense>
        <div className="issues-actions flex flex-wrap items-center gap-2 print:hidden">
          {canDelete ? (
            <Link
              href={isDeletedView ? "/issues" : "/issues?deleted=true"}
              className={`inline-flex h-8 items-center justify-center rounded-lg px-3 text-[13px] font-semibold border transition ${
                isDeletedView
                  ? "border-zk-border bg-zk-surface text-zk-text hover:bg-zk-chip"
                  : "border-zk-bad-bd bg-zk-bad-soft text-zk-bad-fg hover:bg-zk-bad-bg"
              }`}
            >
              {isDeletedView ? "← View active issues" : "View deleted issues"}
            </Link>
          ) : null}
          {finishedWatched > 0 ? <UnwatchFinishedButton count={finishedWatched} /> : null}
          <IssuesToolsToggle
            active={Boolean(searchText || selectedPlatform || selectedTags.length > 0 || isSeverity(severityParam) || selectedMilestone)}
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
        {/* Inbox on the left (the escalated issues, formerly the Escalated tab);
            the status tabs sit at the right of the same row. */}
        <div className="issues-tabs-row flex items-center gap-2.5">
          {!isDeletedView ? (
            <InboxButton href={statusHref(null)} active={isEscalatedView} count={escalatedCount} />
          ) : null}
          {!isDeletedView ? (
            <Link
              href="/issues/history"
              aria-label="Merge history"
              title="Merge history"
              className="inline-flex h-[42px] shrink-0 items-center gap-2 rounded-[10px] border border-zk-divider bg-zk-chip px-3 text-[13px] font-semibold text-zk-text hover:bg-zk-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zk-accent max-sm:h-9"
            >
              <MergeIcon size={16} />
            </Link>
          ) : null}
          {!isDeletedView ? (
            <nav aria-label="Issue status" className="issues-status-nav ml-auto min-w-0">
              <ul>
                {STATUS_TABS.map(({ value, label }) => (
                  <li key={value}>
                    <Link href={statusHref(value)} aria-current={(value === ALL_STATUS ? allSelected : value === statusParam) ? "page" : undefined}>
                      <span className={`issues-status-dot issues-status-${value}`} aria-hidden="true" />
                      {label}<span className="issues-status-count">{tabCount(value)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </div>

        {inboxView ? (
          <>
            {/* How the Inbox works, above its three lists. */}
            {/* One box in two halves: how the Inbox works, and your agents with what they've done. */}
            <section aria-label="How the Inbox works" className="grid overflow-hidden rounded-[14px] border border-zk-border bg-zk-surface md:grid-cols-[minmax(0,1fr)_280px]">
              <div className="flex items-start gap-3 p-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zk-tint text-zk-accent" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
                    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
                  </svg>
                </span>
                <div className="min-w-0">
                  <h2 className="text-sm font-bold text-zk-text">How the Inbox works</h2>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-zk-text2">
                    Agents work through issues on their own and stop here when they need a person: to answer a question, give feedback on a design, or weigh in on a new idea.
                  </p>
                </div>
              </div>
              <div aria-label="Your agents" role="group" className="flex flex-col gap-2 border-zk-divider p-3 max-md:border-t md:border-l">
                <h2 className="text-xs font-bold uppercase tracking-[0.06em] text-zk-muted">Your agents</h2>
                <InboxAgents
                  // Agents waiting on you, then working ones, come first.
                  agents={[...inboxAgents].sort((a, b) => AGENT_ORDER[a.status] - AGENT_ORDER[b.status]).map((agent) => {
                    const done = describeWorkDone(inboxWork.get(agent.id));
                    return {
                      id: agent.id,
                      name: agent.name,
                      avatar: agent.avatar,
                      status: agent.status,
                      activity: agent.activity,
                      done: done ? `Last 30 days: ${done}` : "Nothing done in the last 30 days",
                    };
                  })}
                />
              </div>
            </section>
            <nav aria-label="Inbox lists" className="issues-inbox-tabs overflow-x-auto">
              <ul className="flex w-max gap-1 border-b border-zk-divider">
                {INBOX_TABS.map(({ view, label }) => {
                  const on = inboxView === view;
                  return (
                    <li key={view}>
                      <Link
                        href={inboxHref(view)}
                        aria-current={on ? "page" : undefined}
                        className={`-mb-px inline-flex h-10 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zk-accent ${
                          on ? "border-electric-blue-strong font-semibold text-zk-text" : "border-transparent font-medium text-zk-text2 hover:text-zk-text"
                        }`}
                      >
                        {label}
                        <span className={`rounded-full px-1.5 font-mono text-[11px] tabular-nums ${on ? "bg-zk-tint text-zk-accent" : "bg-zk-chip text-zk-muted"}`}>
                          {inboxCounts[view]}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </>
        ) : null}

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
          <IdeasList ideas={ideaRows} />
        ) : isFirstRun ? (
          <FirstRunWelcome isAdmin={canDelete} hasTenant={Boolean(tenantId)} />
        ) : bugs.length === 0 ? (
          <div className="rounded-[20px] border border-zk-border bg-zk-surface px-4 py-12 text-center">
            <p className="font-bold text-zk-text">
              {inboxView
                ? "Nothing here right now."
                : isWatchingView && !qParam && !statusParam && !severityParam && !tagsParam && !selectedPlatform && !selectedMilestone
                ? "You're not watching any issues."
                : emptyPlatform
                  ? "No issues on this platform"
                  : "No issues match these filters."}
            </p>
            <p className="mt-1.5 text-sm text-zk-muted">
              {inboxView === "input"
                ? "No agent is waiting on an answer."
                : inboxView === "design"
                  ? "No redesign proposals are waiting for a decision."
                  : isWatchingView
                ? "You watch issues you report, are assigned to or comment on, and any you choose to watch from the issue page."
                : emptyPlatform
                  ? "Issues tagged for this platform will show up here."
                  : "Try clearing filters, or report it with New issue."}
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
              <Link href="/issues" className="text-sm font-bold text-zk-accent hover:underline">Clear filters</Link>
            </div>
          </div>
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
                  {canDelete && !isDeletedView ? <span className="issues-selection" aria-hidden="true" /> : null}
                  <span className="w-[52px]">Votes</span>
                  <span className="min-w-0 flex-1">Issue</span>
                  <span className="issues-status-cell">Status</span>
                  <span className="issues-priority">Priority</span>
                  <span className="w-10" aria-hidden="true" />
                </div>
                <ul>
                  {bugs.map((bug, index) => {
                    const userVote =
                      Array.isArray(bug.votes) && bug.votes.length > 0
                        ? voteDirection(bug.votes[0].value ?? 1)
                        : 0;
                    const voterSummary =
                      voterSummaries.get(bug.id) ?? createEmptyVoterSummary();
                    const stage = stages.get(bug.id);
                    const typeName = bug.type?.name ?? "—";
                    const isSecurity = /security/i.test(typeName);
                    const isFeature = !isSecurity && /feature|improve|enhance|request|idea/i.test(typeName);
                    const claim = bug.claims?.[0];
                    // Someone is on it: an active claim, or the issue was moved to in progress.
                    const work = claim || bug.status === "in_progress"
                      ? { person: claim?.beneficiary?.name ?? bug.assignee?.name ?? null, since: claim ? (claim.claimedAt ?? claim.createdAt) : null }
                      : null;
                    const rowStatus = (
                      <IssueRowStatus status={bug.status} stage={stage} botConfirmations={botConfirmations.get(bug.id) ?? 0} work={work}
                        mergePath={bug.reviewStatus === "merged" ? mergePathOf(bug) : null} />
                    );

                    return (
                      <li
                        key={bug.id}
                        data-severity={bug.severity}
                        className={`issues-row flex items-center gap-2 px-2 py-3.5 lg:gap-4 lg:px-4 ${
                          index < bugs.length - 1 ? "border-b border-zk-divider" : ""
                        }`}
                      >
                        {canDelete && !isDeletedView ? (
                          <div className="issues-selection shrink-0">
                            <BulkCheckbox id={bug.id} title={bug.title} />
                          </div>
                        ) : null}
                        <div className="issues-vote w-[52px] shrink-0">
                          <VoteButton
                            bugId={bug.id}
                            voteCount={bug.voteCount}
                            userVote={userVote}
                            likeCount={voterSummary.likes.count}
                            size="sm"
                            chevron
                            readOnly={isDeletedView}
                          />
                        </div>
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
                            <IssueRowStageTallies tallies={stageTallies.get(bug.id)} />
                            {snippets.has(bug.id) ? <SearchSnippet snippet={snippets.get(bug.id)!} /> : null}
                          </span>
                        </Link>
                        <span className="issues-status-cell" aria-hidden="true">{rowStatus}</span>
                        <span className="issues-priority" title={`${severityLabels[bug.severity]} priority`}>
                          <span className="sr-only">{severityLabels[bug.severity]} priority</span>
                          <span className="issues-priority-bars" aria-hidden="true">{[0, 1, 2].map((bar) => <i key={bar} data-active={bar < ({ low: 1, medium: 2, high: 3, critical: 3 }[bug.severity])} />)}</span>
                        </span>
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
                severity: severityParam,
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
    <div className="issues-page mx-auto w-full max-w-6xl space-y-5">
      {headerContent}
      {canDelete && !isDeletedView ? (
        <BulkSelectionProvider
          key={selectionKey}
          pageIds={bugIds}
          types={bulkTypes}
          platforms={bulkPlatforms}
          users={bulkUsers}
        >
          {listContent}
        </BulkSelectionProvider>
      ) : (
        listContent
      )}
    </div>
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
