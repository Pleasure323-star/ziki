import Link from "next/link";
import Image from "next/image";
import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { agentMentionId } from "@/lib/mentions";
import { requireUser } from "@/lib/auth-helpers";
import { bugInTenant, currentTenantIdFor } from "@/lib/tenant-context";
import { viewerBugScope } from "@/lib/tenant-viewer";
import { ideaPath, issuePath, parseIssueRef, queryString, resolveIssueRef } from "@/lib/issue-ref";
import { resolveSessionUserId } from "@/lib/session-user";
import { LocalTime } from "@/components/local-time";
import { ClearDuplicateButton, MarkDuplicateButton } from "@/components/duplicate-controls";
import { currentResolution, isFinishedStatus, type StatusChangeActivity } from "@/lib/resolution-note";
import { statusLabel as resolutionStatusLabel } from "@/lib/labels";
import { formatIssueNumber } from "@/lib/issue-number";
import { openIssueConfirmations, type ConfirmationState, type IssueStage } from "@/lib/issue-stage";
import { buildCommentTree } from "@/lib/comments";
import {
  COMMENT_PARAM,
  COMMENT_THREADS_PER_PAGE,
  earlierThreadsHref,
  loadCommentWindow,
  parseCommentTarget,
  parseThreadWindow,
  type CommentWindow,
} from "@/lib/comment-window";
import { CommentPermalinkResolver } from "@/components/comment-permalink-resolver";
import {
  bugLinkPreviewDescription,
} from "@/lib/link-preview";
import { absoluteUrl } from "@/lib/site-url";
import { SHARE_IMAGE } from "@/lib/share-image";
import {
  severityLabels,
  statusLabels,
} from "@/lib/labels";
import { ActivityTimeline, type ActivityEntry } from "@/components/activity-timeline";
import { type AgentDecision } from "@/components/issue-agent-activity";
import { IssueProgressReport } from "@/components/issue-progress-report";
import { IssueStageProvider } from "@/components/issue-stage-context";
import { IssueStageSummary } from "@/components/issue-stage-summary";
import { IssueComments } from "@/components/comment-thread";
import { CommentComposer } from "@/components/comment-composer";
import { AwardBox } from "@/components/award-box";
import { issueHolds, type IssueHold } from "@/lib/issue-holders";
import {
  claimDecisionKind,
  currentDecisionStage,
  payloadMerged,
  stageSetback,
} from "@/lib/decision-stages";
import { IssueEscalations, type TicketEscalation } from "@/components/issue-escalations";
import { listBugEscalations } from "@/lib/agent-questions";
import { IssueBidsPanel, type BidEntryView } from "@/components/issue-bids";
import { bidHistoryEntries } from "@/lib/agent-api/bid";
import { testVerdictEntries } from "@/lib/agent-api/test-verdict";
import { mergeReviewEntries } from "@/lib/agent-api/merge";
import { MergeReviewsPanel, TestVerdictsPanel, type MergeReviewView, type TestVerdictView } from "@/components/issue-review-entries";
import { GoalBudgetSection } from "@/components/goal-budgets";
import { Badge } from "@/components/ui/badge";
import { VoteButton } from "@/components/vote-button";
import { ImportanceReasons } from "@/components/importance-reasons";
import { fetchImportanceReasons, type ImportanceReason } from "@/lib/importance-marks";
import { type IdeaVerdictsData } from "@/components/idea-verdicts";
import { listIdeaVerdicts } from "@/lib/agent-api/idea-verdicts";
import { UpdateIssueForm } from "@/components/update-issue-form";
import { IssueConfirmationsPanel, type ConfirmationBlock, type ConfirmationsData } from "@/components/issue-confirmations";
import { CONFIRMATION_SUMMARY_MAX_CHARS, listConfirmations } from "@/lib/agent-api/confirmations";
import { DisputeAwardDialog, type DisputeRole } from "@/components/dispute-award-dialog";
import { AttachmentList, type AttachmentView } from "@/components/attachment-list";
import { ChooseRedesignButton } from "@/components/choose-redesign-button";
import { IssueApprovalBanner } from "@/components/issue-approval-banner";
import { isTenantAdminRole } from "@/lib/agents/membership";
import type { OrganizationRole } from "@/lib/organization-role";
import { UserNameWithBadges } from "@/components/user-name-with-badges";
import { getActiveIssueTypesCached, getActivePlatforms } from "@/lib/lookups";
import { fetchVoterSummary } from "@/lib/voter-summaries";
import { createEmptyVoterSummary } from "@/lib/voters";
import {
  canDeleteTicket,
  deletedSummary,
  deletionCounts,
  deleteSummary,
} from "@/lib/ticket-deletion";
import { currentTenantAccess } from "@/lib/tenant-access";
import { MilestoneDue } from "@/components/milestone-due";
import { LoadError } from "@/components/load-error";
import { logLoadFailure } from "@/lib/load-error";
import { dueDateValue, milestoneIssuesHref } from "@/lib/milestones";
import { canEditTicket } from "@/lib/ticket-editing";
import { DeleteIssueButton } from "@/components/delete-issue-button";
import { RestoreIssueButton } from "@/components/restore-issue-button";
import { canAssignTicket } from "@/lib/ticket-assignment";
import { SelfAssignButton } from "@/components/self-assign-button";
import { EditableIssueDescription } from "@/components/editable-issue-description";
import { EditableProofLinks } from "@/components/editable-proof-links";
import { withCurrentOption } from "@/lib/triage-options";
import { issueTenantHintFor } from "@/lib/issue-tenant-hint";
import { IssueTenantSwitch } from "@/components/issue-tenant-hint";
import { tenantMemberWhere } from "@/lib/tenant-mentions";
import { readAgentResolution } from "@/lib/agent-resolution";
import { AgentResolvedNotice } from "@/components/agent-resolved-notice";
import { ReviewStatusBadge } from "@/components/review-status-badge";
import { SubmissionEvidence } from "@/components/submission-evidence";
import { voteDirection } from "@/lib/voting";
import {
  issueChipBaseClass,
  issueSeverityChipClass,
  issueStatusChipClass,
} from "./issue-ui";
import "./issue-detail.css";

type BugPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const NO_COMMENTS: CommentWindow = {
  comments: [],
  shownThreads: 0,
  hiddenThreads: 0,
  visibleCount: 0,
};

/** How much of the activity log a single page render is allowed to load. */
const ACTIVITY_PAGE_SIZE = 50;

async function loadOptional<T>(label: string, fallback: T, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    console.error(`[issue] ${label} failed`, error);
    return fallback;
  }
}

/** Why a merger agent's deployment failed (#1446), from its audit payload. */
function payloadReason(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const reason = (payload as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim() ? reason : null;
}

/** The database error stays in the server log under `reference`. */
function issueLoadError(reference: string) {
  return <LoadError title="This issue could not be loaded" reference={reference} />;
}

export async function generateMetadata({
  params,
}: BugPageProps): Promise<Metadata> {
  const { id: rawId } = await params;
  const scope = await viewerBugScope();
  const ref = await resolveIssueRef(prisma, parseIssueRef(rawId), scope);
  const bug = ref && await prisma.bug.findUnique({
    where: { id: ref.id, ...scope },
    select: {
      number: true,
      title: true,
      status: true,
      updatedAt: true,
      isDeleted: true,
    },
  });

  if (!bug || bug.isDeleted) {
    return {
      title: "Issue not found",
      description: "This issue could not be found.",
      robots: { index: false, follow: false },
    };
  }

  // Title and status only: these tags are served to anyone with a preview-bot
  // User-Agent, signed in or not (#117).
  const description = bugLinkPreviewDescription({ status: bug.status });
  const canonical = absoluteUrl(issuePath(bug.number));
  const image = absoluteUrl(SHARE_IMAGE.url);
  // The reference goes in the tab title too: with several issues open, the
  // number is what tells two similar titles apart.
  const title = `${formatIssueNumber(bug.number)} ${bug.title}`;

  return {
    title,
    description,
    alternates: { canonical },
    robots: { index: false, follow: false },
    openGraph: {
      title,
      description,
      url: canonical,
      type: "article",
      siteName: "Ziki",
      modifiedTime: bug.updatedAt.toISOString(),
      images: [{ ...SHARE_IMAGE, url: image }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
    other: {
      "bug:status": statusLabels[bug.status],
    },
  };
}

/**
 * Renders the issue detail page including discussion threads, activity
 * timeline, attachment viewer, and triage controls.
 *
 * Performance optimization (#349): Gating the full user directory query behind
 * `canTriage` ensures non-triage viewers do not run unnecessary database queries.
 *
 * @param props.params - Route parameters containing the issue `id`.
 * @param props.searchParams - Optional query params for thread windowing or permalinks.
 */
export default async function BugDetailPage({ params, searchParams }: BugPageProps) {
  const { id: rawId } = await params;
  const ref = parseIssueRef(rawId);
  const query = (await searchParams) ?? {};
  const resolved = await resolveSessionUserId();
  const userId = "userId" in resolved ? resolved.userId : undefined;

  // Unauthenticated link-preview bots get the title and status only (#117).
  // They're recognised by User-Agent, which anyone can fake, so nothing more
  // sensitive (reporter, severity, description) may appear here.
  if (!userId) {
    // A bare number needs the viewer's organisation, so a signed-out preview
    // can only resolve the internal id (#457).
    const bug = ref.kind === "id" && await prisma.bug.findUnique({
      where: { id: ref.id },
      select: {
        title: true,
        status: true,
        reviewStatus: true,
        isDeleted: true,
      },
    });
    if (!bug || bug.isDeleted) notFound();

    return (
      <div className="issue-detail-scope mx-auto max-w-2xl space-y-4 py-10">
        <p className="text-sm text-zk-muted">Ziki Issues</p>
        <h1 className="text-2xl font-extrabold text-zk-text">{bug.title}</h1>
        <div className="flex flex-wrap gap-2">
          <Badge className={`${issueChipBaseClass} ${issueStatusChipClass[bug.status]}`}>
            {statusLabels[bug.status]}
          </Badge>
          <ReviewStatusBadge status={bug.reviewStatus} />
        </div>
        <Link
          href={`/login?callbackUrl=${encodeURIComponent(`/issues/${rawId}`)}`}
          className="inline-flex text-sm font-bold text-zk-accent hover:underline"
        >
          Sign in to view full details
        </Link>
      </div>
    );
  }

  const user = await requireUser();
  const access = await currentTenantAccess(user.id, user.role);
  const canTriage = access.admin;
  const canDelete = canDeleteTicket(user.role, access.membershipRole);
  const userTenantId = await currentTenantIdFor(userId);
  // #457: the address is the readable number. An old internal-id link redirects
  // to it, keeping comment permalinks and other query parameters.
  const found = await resolveIssueRef(prisma, ref, bugInTenant(userTenantId));
  if (found && ref.kind === "id") {
    // The page streams, so this redirect happens in the browser and can drop
    // the #fragment; a comment permalink gets its anchor back from the query.
    const comment = parseCommentTarget(query[COMMENT_PARAM]);
    permanentRedirect(`${issuePath(found.number)}${queryString(query)}${comment ? `#comment-${comment}` : ""}`);
  }
  const id = found?.id ?? (ref.kind === "id" ? ref.id : "");
  // #289: open milestones for the triage panel (admins only). Started here,
  // alongside the issue query, and awaited where the form needs them.
  const milestoneOptionsPromise: Promise<{ id: string; title: string; isClosed: boolean }[]> = canTriage
    ? loadOptional("milestones", [], () =>
        userTenantId
          ? prisma.milestone.findMany({
              where: { isClosed: false, tenantId: userTenantId },
              select: { id: true, title: true, isClosed: true },
              orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { title: "asc" }],
            })
          : Promise.resolve([]),
      )
    : Promise.resolve([]);

  // The list page already proved the issue row itself can be read. Comments,
  // the activity log, watches and attachments are newer tables. One of them
  // missing used to reject this whole Promise and blank the page.
  let loadedBug = await prisma.bug
    .findUnique({
      where: { id, ...bugInTenant(await currentTenantIdFor(userId)) },
      include: {
        type: { select: { id: true, name: true, isActive: true } },
        reporter: { select: { name: true, email: true, role: true, image: true } },
        createdByAgent: { select: { id: true, name: true, ownerUserId: true } },
        idea: { select: { id: true, number: true, convertedAt: true } },
        milestone: { select: { id: true, title: true, dueDate: true, isClosed: true } },
        assignee: { select: { id: true, name: true, role: true, image: true } },
        category: { select: { id: true, name: true, isActive: true } },
        area: { select: { id: true, name: true } },
        votes: { where: { userId }, select: { id: true, value: true }, take: 1 },
        // #285: both sides of a duplicate link.
        duplicateOf: { select: { id: true, number: true, title: true, status: true, isDeleted: true } },
        duplicates: {
          where: { isDeleted: false },
          select: { id: true, number: true, title: true, status: true },
          orderBy: { number: "asc" },
          take: 20,
        },
        _count: { select: { duplicates: { where: { isDeleted: false } } } },
      },
    })
    .then((bug) => ({ bug }))
    .catch((error: unknown) => ({
      // `detail` only decides the milestone retry below; it is never shown.
      detail: error instanceof Error ? error.message : "",
      reference: logLoadFailure("[issue] detail query failed", error),
    }));

  // If the query failed because Bug.milestoneId or Milestone does not exist in
  // the current database, retry without the milestone relation so the page
  // continues to load cleanly (#289).
  if ("detail" in loadedBug && /milestoneId|Milestone/i.test(loadedBug.detail)) {
    loadedBug = await prisma.bug
      .findUnique({
        where: { id, ...bugInTenant(await currentTenantIdFor(userId)) },
        include: {
          type: { select: { id: true, name: true, isActive: true } },
          reporter: { select: { name: true, email: true, role: true, image: true } },
          createdByAgent: { select: { id: true, name: true, ownerUserId: true } },
          idea: { select: { id: true, number: true, convertedAt: true } },
          assignee: { select: { id: true, name: true, role: true, image: true } },
          category: { select: { id: true, name: true, isActive: true } },
          area: { select: { id: true, name: true } },
          votes: { where: { userId }, select: { id: true, value: true }, take: 1 },
          duplicateOf: { select: { id: true, number: true, title: true, status: true, isDeleted: true } },
          duplicates: {
            where: { isDeleted: false },
            select: { id: true, number: true, title: true, status: true },
            orderBy: { number: "asc" },
            take: 20,
          },
          _count: { select: { duplicates: { where: { isDeleted: false } } } },
        },
      })
      .then((bug) => ({
        bug: bug
          ? {
              ...bug,
              milestoneId: null,
              milestone: null,
            }
          : null,
      }))
      .catch((error: unknown) => ({
        detail: error instanceof Error ? error.message : "",
        reference: logLoadFailure("[issue] fallback detail query without milestone failed", error),
      }));
  }

  if ("reference" in loadedBug) {
    return issueLoadError(loadedBug.reference);
  }
  const bug = loadedBug.bug;

  if (!bug) {
    // A link into another of the viewer's tenants should not dead-end (#519):
    // name the tenant and offer the switch. Non-members still get the 404.
    const hint = await issueTenantHintFor(prisma, {
      userId,
      activeTenantId: await currentTenantIdFor(userId),
      issueId: id,
    });
    if (!hint) notFound();
    return <IssueTenantSwitch issueId={id} tenant={hint} />;
  }

  if (bug.isDeleted && !canDelete) {
    notFound();
  }

  const tenantId = await currentTenantIdFor(userId);
  // These tables arrived after the issue row. A missing one must not blank the page.
  const [redesignProposals, membership] = tenantId ? await Promise.all([
    loadOptional("redesigns", [], () =>
      prisma.redesignProposal.findMany({
        where: { tenantId, bugId: bug.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, title: true, body: true, previewUrl: true, status: true,
          authorAgent: { select: { name: true } }, attachments: { select: { id: true, filename: true, contentType: true } } },
      }),
    ),
    loadOptional("membership", null, () =>
      prisma.membership.findUnique({ where: { tenantId_userId: { tenantId, userId } }, select: { role: true } }),
    ),
  ]) : [[], null] as const;
  const canChooseRedesign = isTenantAdminRole(membership?.role, user.role);
  // Once an issue is past Requires confirmation, the Conversation opens on who
  // has it (its claims), then every bid it took (#issue-bids).
  const pastConfirmation = bug.status !== "requires_confirmation";
  const [holds, bidList] = pastConfirmation
    ? await Promise.all([
        loadOptional<IssueHold[]>("holders", [], () => issueHolds(bug.id)),
        loadOptional<BidEntryView[]>("bids", [], () => bidHistoryEntries({ id: bug.id, areaId: bug.areaId ?? null })),
      ])
    : [[] as IssueHold[], [] as BidEntryView[]];
  const canAwardBid = bug.status === "open" && !bug.isDeleted && (bug.reporterId === user.id || canChooseRedesign);

  // #importance: started now, read after the batch below, so it runs alongside it.
  const importanceReasonsLoad = loadOptional<ImportanceReason[]>("importance reasons", [], () => fetchImportanceReasons(bug.id));
  const [users, categories, areas, types, voterSummary, activities, activityCount, comments, latestStatusChange, attachments, lastRevision, agentDecisions, escalations, pendingApproval] =
    await Promise.all([
      canTriage
        ? loadOptional("users", [], () =>
            // #502: only the issue's tenant can be mentioned or assigned.
            prisma.user.findMany({
              where: tenantMemberWhere(bug.tenantId),
              orderBy: { name: "asc" },
              select: { id: true, name: true, role: true, image: true },
            }),
          )
        : Promise.resolve([]),
      loadOptional("platforms", [], () => getActivePlatforms(bug.tenantId)),
      canTriage
        ? loadOptional("project areas", [], () => prisma.projectArea.findMany({
            where: { projectId: bug.projectId },
            orderBy: [{ name: "asc" }, { id: "asc" }],
            select: { id: true, name: true },
          }))
        : Promise.resolve([]),
      canTriage ? loadOptional("types", [], () => getActiveIssueTypesCached(bug.tenantId)) : Promise.resolve([]),
      loadOptional("votes", createEmptyVoterSummary(), () => fetchVoterSummary(id)),
      loadOptional("activity", [] as ActivityEntry[], () =>
        prisma.bugActivity.findMany({
          where: { bugId: id },
          include: { actor: { select: { name: true } } },
          orderBy: { createdAt: "desc" },
          take: ACTIVITY_PAGE_SIZE,
        }),
      ),
      loadOptional("activity count", 0, () => prisma.bugActivity.count({ where: { bugId: id } })),
      // The newest threads only (#280); a permalink widens the window to
      // reach its comment.
      loadOptional("comments", NO_COMMENTS, () =>
        loadCommentWindow(prisma, id, {
          threads: parseThreadWindow(query.threads),
          target: parseCommentTarget(query.comment),
        }),
      ),
      // #316: the status change that put the issue in its current state,
      // read on its own so it is found even when the timeline is trimmed.
      isFinishedStatus(bug.status)
        ? loadOptional<StatusChangeActivity | null>("resolution note", null, () =>
            prisma.bugActivity.findFirst({
              where: { bugId: id, type: "status_changed" },
              orderBy: { createdAt: "desc" },
              select: { createdAt: true, metadata: true, actor: { select: { name: true } } },
            }),
          )
        : Promise.resolve(null),
      // Files on the issue and on its comments (#215); never the file contents here.
      loadOptional("attachments", [], () =>
        prisma.attachment.findMany({
          where: { bugId: id },
          select: { id: true, filename: true, contentType: true, size: true, commentId: true },
          orderBy: { createdAt: "asc" },
        }),
      ),
      // #303: only whether there is history, and when it last changed.
      loadOptional<{ editedAt: Date } | null>("revisions", null, () =>
        prisma.bugRevision.findFirst({
          where: { bugId: id },
          orderBy: { editedAt: "desc" },
          select: { editedAt: true },
        }),
      ),
      // #448: what agents decided on this issue — confirmations and rejections
      // (#1122), the claim, test verdicts, and whether an agent accepted the
      // fix. Sentences only; the raw audit payloads live on the audit page (#447).
      loadOptional<AgentDecision[]>(
        "agent decisions",
        [],
        async () => {
          const [confirmations, claims, verdicts, reviews, accepted] = await Promise.all([
            // #issue-confirmations: confirm and reject entries; neutral decides nothing.
            prisma.issueConfirmation.findMany({
              where: { bugId: id, verdict: { in: ["confirm", "reject"] }, undoneAt: null },
              orderBy: { updatedAt: "asc" },
              select: {
                id: true,
                updatedAt: true,
                verdict: true,
                severity: true,
                summary: true,
                agent: { select: { name: true } },
                onBehalfOf: { select: { name: true } },
              },
            }),
            // #1446: released claims too; a claim released for any reason but
            // the fix landing counts as a rejected claim at the Open stage.
            prisma.issueClaim.findMany({
              where: { bugId: id, claimedAt: { not: null } },
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                createdAt: true,
                status: true,
                claimedAt: true,
                releasedAt: true,
                releaseReason: true,
                deliverBy: true,
                extendedAt: true,
                waitingOnOwnerSince: true,
                agent: { select: { name: true, owner: { select: { name: true } } } },
                beneficiary: { select: { name: true } },
              },
            }),
            prisma.testVerdict.findMany({
              where: { bugId: id },
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                createdAt: true,
                goodToMerge: true,
                agent: { select: { name: true } },
                onBehalfOf: { select: { name: true } },
              },
            }),
            // #review-entries: a manager agent's accept or reject (#1429) is its merge review.
            prisma.mergeReview.findMany({
              where: { bugId: id },
              orderBy: { createdAt: "asc" },
              select: { id: true, createdAt: true, verdict: true, summary: true, agent: { select: { name: true } } },
            }),
            // #1446: the merger agent's merge and its failed deployments are actions, in the audit log.
            prisma.agentAuditEvent.findMany({
              where: { bugId: id, action: { in: ["issue.accepted", "github.merge_failed"] } },
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                createdAt: true,
                action: true,
                agent: { select: { name: true, level: true } },
                payload: true,
              },
            }),
          ]);

          const mergerDecisions: AgentDecision[] = [
            ...reviews.map<AgentDecision>((r) =>
              r.verdict === "reject"
                ? { id: `merge-review-${r.id}`, at: r.createdAt, kind: "merge_rejected", agentName: r.agent.name, notes: r.summary }
                : { id: `merge-review-${r.id}`, at: r.createdAt, kind: "accepted", agentName: r.agent.name },
            ),
            ...accepted
              .filter((e) => e.action === "github.merge_failed" || payloadMerged(e.payload))
              .map<AgentDecision>((e) =>
                e.action === "github.merge_failed"
                  ? {
                      id: `deploy-failed-${e.id}`,
                      at: e.createdAt,
                      kind: "deploy_failed",
                      agentName: e.agent.name,
                      reason: payloadReason(e.payload),
                    }
                  : { id: `accepted-${e.id}`, at: e.createdAt, kind: "accepted", agentName: e.agent.name, merged: true },
              ),
          ];

          const otherDecisions: AgentDecision[] = [
            // A person's own entry names them; an agent's names the agent, for its owner.
            ...confirmations.map<AgentDecision>((v) =>
              v.verdict === "reject"
                ? {
                    id: `confirmation-${v.id}`,
                    at: v.updatedAt,
                    kind: "rejected",
                    agentName: v.agent?.name ?? v.onBehalfOf.name,
                    personName: v.agent ? v.onBehalfOf.name : "",
                    notes: v.summary,
                  }
                : {
                    id: `confirmation-${v.id}`,
                    at: v.updatedAt,
                    kind: "confirmed",
                    agentName: v.agent?.name ?? v.onBehalfOf.name,
                    personName: v.agent ? v.onBehalfOf.name : "",
                    severity: v.severity,
                  },
            ),
            ...claims.flatMap<AgentDecision>((c) => {
              const kind = claimDecisionKind(c);
              if (kind === "claim_released") {
                return [
                  {
                    id: `claim-${c.id}`,
                    at: c.releasedAt ?? c.createdAt,
                    kind,
                    agentName: c.agent.name,
                    personName: c.beneficiary.name,
                  },
                ];
              }
              if (kind !== "claimed") return [];
              const active = c.status === "active";
              return [
                {
                  id: `claim-${c.id}`,
                  at: c.createdAt,
                  kind,
                  agentName: c.agent.name,
                  personName: c.beneficiary.name,
                  deliverBy: bug.pullRequestUrl || !active ? null : c.deliverBy,
                  extendedAt: c.extendedAt,
                  waitingOnName: active && c.waitingOnOwnerSince ? c.agent.owner.name : null,
                },
              ];
            }),
            ...verdicts.map<AgentDecision>((v) => ({
              id: `verdict-${v.id}`,
              at: v.createdAt,
              kind: "verdict",
              agentName: v.agent.name,
              personName: v.onBehalfOf.name,
              goodToMerge: v.goodToMerge,
            })),
          ].sort((a, b) => {
            const at = new Date(a.at).getTime() - new Date(b.at).getTime();
            if (at !== 0) return at;
            return a.id.localeCompare(b.id);
          });

          // #1446: merger decisions sit with the rest, counted by stage.
          return [...otherDecisions, ...mergerDecisions];
        },
      ),
      loadOptional<TicketEscalation[]>("escalations", [], () =>
        tenantId ? listBugEscalations(id, tenantId) : Promise.resolve([]),
      ),
      loadOptional("pendingApproval", null, () =>
        (typeof (prisma as { issueApproval?: unknown }).issueApproval !== "undefined"
          ? prisma.issueApproval.findFirst({
              where: { bugId: id, status: "pending" },
              include: { rule: { include: { issueType: { select: { name: true } } } } },
              orderBy: { createdAt: "desc" },
            })
          : Promise.resolve(null)),
      ),
    ]);
  const importanceReasons = await importanceReasonsLoad;
  // #603: the tenant's active agents, offered in the comment @mention list
  // as "Mark's Claude · Mark Essien" alongside people.
  const mentionAgents = canTriage
    ? await loadOptional("mention agents", [], () =>
        prisma.agent.findMany({
          where: { tenantId: bug.tenantId, revokedAt: null },
          orderBy: { name: "asc" },
          select: { id: true, name: true, owner: { select: { name: true } } },
        }),
      )
    : [];
  const commentMentionUsers = [
    ...users,
    ...mentionAgents.map((agent) => ({
      id: agentMentionId(agent.id),
      name: agent.name,
      agentOwner: agent.owner.name,
    })),
  ];
  const issueAttachments: AttachmentView[] = attachments.filter((a) => !a.commentId);
  const attachmentsByComment: Record<string, AttachmentView[]> = {};
  for (const a of attachments) {
    if (a.commentId) (attachmentsByComment[a.commentId] ??= []).push(a);
  }

  const milestoneOptions = await milestoneOptionsPromise;
  let intakeStage: IssueStage | null = null;
  let confirmation: ConfirmationState | null = null;
  if (!bug.isDeleted && (bug.status === "open" || bug.status === "requires_confirmation")) {
    try {
      confirmation = (await openIssueConfirmations(prisma, { id: bug.id })).get(bug.id) ?? null;
      intakeStage = confirmation?.stage ?? null;
    } catch (error) {
      console.error("[bugs] issue stage lookup failed", error);
    }
  }
  // #idea-table: the verdicts of the idea this issue was converted from, for the Idea stage.
  const sourceIdea = bug.idea;
  const ideaVerdicts: IdeaVerdictsData | null = sourceIdea
    ? await loadOptional<IdeaVerdictsData | null>("idea verdicts", null, () =>
        listIdeaVerdicts({ tenantId: bug.tenantId, projectId: bug.projectId }, sourceIdea.id),
      )
    : null;
  // #issue-confirmations: at Requires confirmation the issue takes confirmation
  // entries; afterwards they stay, read-only, under the comments.
  const confirming = !bug.isDeleted && bug.status === "requires_confirmation";
  const confirmationsData: ConfirmationsData | null = await loadOptional<ConfirmationsData | null>("confirmations", null, () =>
    listConfirmations({ tenantId: bug.tenantId, projectId: bug.projectId }, bug.id),
  );
  const confirmationBlock: ConfirmationBlock =
    bug.reporterId === user.id || bug.beneficiaryUserId === user.id ? "own" : null;
  const isAssignee = !!userId && bug.assigneeId === userId;
  const canUpdateStatus = canTriage || isAssignee;
  const canEdit =
    canEditTicket({
      actorId: userId,
      actorRole: user.role,
      membershipRole: access.membershipRole,
      reporterId: bug.reporterId,
    }) && !bug.isDeleted;
  const canSelfAssign =
    !bug.isDeleted &&
    canAssignTicket({
      actorId: userId,
      actorRole: user.role,
      membershipRole: access.membershipRole,
      currentAssigneeId: bug.assigneeId,
      targetAssigneeId: isAssignee ? null : userId,
    });
  const userVote =
    Array.isArray(bug.votes) && bug.votes.length > 0
      ? voteDirection(bug.votes[0].value ?? 1)
      : 0;
  const commentTree = buildCommentTree(comments.comments);
  // #1446: the stage the page opens on, and what each stage holds.
  const currentStage = currentDecisionStage({
    status: bug.status,
    reviewStatus: bug.reviewStatus,
    pullRequestUrl: bug.pullRequestUrl,
    hasClaim: agentDecisions.some((d) => d.kind === "claimed"),
    ideaAccepted: intakeStage === "ready",
  });
  // #review-entries: at Done the issue takes test verdicts, at Ready to merge
  // merge reviews, not comments.
  const reviewBug = { id: bug.id, pullRequestUrl: bug.pullRequestUrl ?? null, pullRequestHeadSha: bug.pullRequestHeadSha ?? null };
  const testing = !bug.isDeleted && currentStage === "done";
  const mergeReviewing = !bug.isDeleted && currentStage === "ready";
  // Taken at their own stage; read-only afterwards.
  const [testVerdictList, mergeReviewList] = pastConfirmation
    ? await Promise.all([
        loadOptional<TestVerdictView[]>("test verdicts", [], () => testVerdictEntries(reviewBug)),
        loadOptional<MergeReviewView[]>("merge reviews", [], () => mergeReviewEntries(reviewBug)),
      ])
    : [[] as TestVerdictView[], [] as MergeReviewView[]];
  // Comments on the issue itself: taken only while it is Open (lib/comment-placement.ts).
  const takesComments = !bug.isDeleted && bug.status === "open";
  const commentCount = comments.shownThreads + comments.hiddenThreads;
  // #489: the Admin label follows each person's role in this issue's
  // organization, not their account-wide role, the same rule as admin powers.
  const namedUserIds = [
    ...new Set(
      [bug.reporterId, bug.assigneeId, ...comments.comments.map((c) => c.authorId)].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  ];
  const organizationRoleRows = await loadOptional<{ userId: string; role: OrganizationRole }[]>(
    "organization roles",
    [],
    () =>
      prisma.membership.findMany({
        where: { tenantId: bug.tenantId, userId: { in: namedUserIds } },
        select: { userId: true, role: true },
      }),
  );
  const organizationRoles: Record<string, OrganizationRole> = Object.fromEntries(
    organizationRoleRows.map((row) => [row.userId, row.role]),
  );
  const pageQuery = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") pageQuery.set(key, value);
  }
  const proofLinks = bug.proofLinks ?? [];
  const prActivity = activities.find((a) => {
    const meta = a.metadata as Record<string, unknown> | null;
    return meta && (meta.screenshots || meta.testResults || meta.field === "pullRequestUrl");
  });
  const prMeta = prActivity?.metadata as Record<string, unknown> | null;
  const submissionScreenshots: string[] = Array.isArray(prMeta?.screenshots)
    ? (prMeta?.screenshots as string[])
    : proofLinks.filter((l) => /\.(png|jpe?g|webp|gif|svg)($|\?)/i.test(l));
  const submissionTestResults = (prMeta?.testResults as string | Record<string, unknown> | null) ?? null;

  const resolution = currentResolution(bug.status, latestStatusChange);
  const agentResolution =
    bug.status === "resolved" && !bug.isDeleted ? readAgentResolution(latestStatusChange?.metadata) : null;

  // "Dispute award", for the issue's reporter and assignee: its own button now
  // that issues take no free-standing comments (#entry-replies-only).
  const disputeRoles: DisputeRole[] = bug.isDeleted
    ? []
    : [
        ...(userId && bug.assigneeId === userId ? (["solver"] as const) : []),
        ...(userId && bug.reporterId === userId ? (["reporter"] as const) : []),
      ];

  const headerActions = (
    <>
      {canSelfAssign ? (
        <SelfAssignButton
          bugId={bug.id}
          isAssignedToMe={isAssignee}
          size="sm"
        />
      ) : null}
      {canTriage && !bug.isDeleted && !bug.duplicateOf ? (
        <MarkDuplicateButton bugId={bug.id} />
      ) : null}
    </>
  );

  // What a delete keeps, shown the same way in every delete/restore message (#692).
  const keptCounts = deletionCounts(comments.visibleCount, voterSummary);

  return (
    <div className="issue-detail-scope flex flex-col gap-5 pb-10">
      {bug.isDeleted ? (
        <div className="rounded-[20px] border border-zk-bad-bd bg-zk-bad-bg p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-zk-bad-fg">
                This issue was deleted
              </h3>
              <p className="text-xs text-zk-bad-fg/90">
                {deletedSummary(keptCounts)}
              </p>
            </div>
            <RestoreIssueButton
              bugId={bug.id}
              bugTitle={bug.title}
              counts={keptCounts}
              size="sm"
            />
          </div>
        </div>
      ) : null}

      {bug.duplicateOf ? (
        <section
          aria-label="Duplicate"
          className="flex flex-col gap-2 rounded-[20px] border border-zk-warn-bd bg-zk-warn-bg p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
        >
          <p className="text-sm text-zk-warn-fg">
            <span className="font-semibold">This issue is a duplicate of </span>
            {bug.duplicateOf.isDeleted && !canDelete ? (
              <span>{formatIssueNumber(bug.duplicateOf.number)} (since deleted)</span>
            ) : (
              <Link href={issuePath(bug.duplicateOf.number)} className="font-semibold text-zk-accent underline-offset-2 hover:underline">
                {formatIssueNumber(bug.duplicateOf.number)} {bug.duplicateOf.title}
              </Link>
            )}{" "}
            <span>({statusLabels[bug.duplicateOf.status]})</span>.{" "}
            Follow it and mark it important there instead. It&apos;s hidden from the issues list.
          </p>
          {canTriage ? (
            <div className="flex shrink-0 items-center gap-1 print:hidden">
              <MarkDuplicateButton bugId={bug.id} label="Change" />
              <ClearDuplicateButton bugId={bug.id} />
            </div>
          ) : null}
        </section>
      ) : null}

      {bug._count.duplicates > 0 ? (
        <section aria-label="Duplicates of this issue" className="rounded-[20px] border border-zk-border bg-zk-surface p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-zk-text">
            {bug._count.duplicates} duplicate{bug._count.duplicates === 1 ? "" : "s"} of this issue
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {bug.duplicates.map((d) => (
              <li key={d.id}>
                <Link href={issuePath(d.number)} className="text-zk-accent hover:underline">
                  <span className="tabular-nums text-zk-muted">{formatIssueNumber(d.number)}</span> {d.title}
                </Link>{" "}
                <span className="text-xs text-zk-muted">· {statusLabels[d.status]}</span>
              </li>
            ))}
          </ul>
          {bug._count.duplicates > bug.duplicates.length ? (
            <p className="mt-1 text-xs text-zk-muted">
              And {bug._count.duplicates - bug.duplicates.length} more.
            </p>
          ) : null}
        </section>
      ) : null}

      {pendingApproval ? (
        <IssueApprovalBanner
          approval={pendingApproval}
          canDecide={canChooseRedesign}
        />
      ) : null}

      {redesignProposals.length ? (
        <section aria-label="Redesign proposals" className="rounded-[20px] border border-zk-border bg-zk-surface p-4 sm:p-5">
          <h2 className="text-lg font-semibold text-zk-text">Compare redesign proposals</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {redesignProposals.map((proposal) => (
              <article key={proposal.id} className="space-y-3 rounded-[16px] border border-zk-border bg-zk-chip/40 p-4">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-semibold text-zk-text">{proposal.title}</h3>
                  <span className="shrink-0 text-xs capitalize text-zk-muted">{proposal.status}</span>
                </div>
                <p className="text-xs text-zk-muted">By {proposal.authorAgent.name}</p>
                <p className="whitespace-pre-wrap text-sm text-zk-text2">{proposal.body}</p>
                {proposal.previewUrl ? <a className="text-sm font-bold text-zk-accent underline" href={proposal.previewUrl} target="_blank" rel="noreferrer">Open live preview</a> : null}
                {proposal.attachments.length ? <div className="grid grid-cols-2 gap-2">
                  {proposal.attachments.map((file) => <a key={file.id} href={`/api/attachments/${file.id}`} target="_blank" rel="noreferrer" className="space-y-1 text-sm font-bold text-zk-accent underline">
                    <Image src={`/api/attachments/${file.id}`} alt={file.filename} width={480} height={320} unoptimized className="h-auto max-h-56 w-full rounded-xl border border-zk-border object-contain" />
                    <span className="block">{file.filename}</span>
                  </a>)}
                </div> : null}
                {canChooseRedesign && proposal.status === "proposed" ? <ChooseRedesignButton id={proposal.id} /> : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {resolution ? (
        <section
          aria-label="Resolution note"
          className="rounded-[20px] border border-zk-border bg-zk-ok-bg p-4 sm:p-5"
        >
          <h2 className="text-sm font-semibold text-zk-ok-fg">
            {resolutionStatusLabel[resolution.status]} by {resolution.by}
            <span className="ml-2 text-xs font-normal">
              <LocalTime date={resolution.at} />
            </span>
          </h2>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zk-text">
            {resolution.note}
          </p>
        </section>
      ) : null}

      {/* Header: number + title, status language, importance */}
      <div className="flex flex-col gap-3.5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-[1_1_600px] space-y-3">
            <div className="flex items-start gap-2">
              <Link
                href="/issues"
                aria-label="Back to issues"
                title="Back to issues"
                className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zk-accent hover:bg-zk-chip print:hidden"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </Link>
              <h1 className="min-w-0 break-words text-[28px] font-extrabold leading-tight tracking-[-0.02em] text-zk-text">
                <span className="font-bold tabular-nums text-zk-muted">
                  {formatIssueNumber(bug.number)}
                </span>{" "}
                {bug.title}
              </h1>
            </div>

            {agentResolution ? (
              <AgentResolvedNotice bugId={bug.id} resolution={agentResolution} canReopen={canUpdateStatus} />
            ) : null}

            {/* On mobile (<sm): compact horizontal scroll action row pinned directly under the title (#698) */}
            <div
              data-testid="mobile-actions-row"
              className="flex items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden sm:hidden print:hidden"
            >
              {headerActions}
            </div>

            {/* Taxonomy (#687). Status, severity, stage and the opened date are in the Status box. */}
            {bug.type || bug.category ? (
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-zk-muted">
                {bug.type ? (
                  <span className={`${issueChipBaseClass} bg-zk-chip text-zk-text2`}>{bug.type.name}</span>
                ) : null}
                {bug.category ? (
                  <span className={`${issueChipBaseClass} bg-zk-chip text-zk-text2`}>{bug.category.name}</span>
                ) : null}
              </p>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 self-start print:hidden">
            <div className="hidden sm:contents">{headerActions}</div>
            <VoteButton
              bugId={bug.id}
              voteCount={bug.voteCount}
              userVote={userVote}
              likeCount={voterSummary.likes.count}
              likeVoters={voterSummary.likes.voters}
              size="md"
              showAvatars={false}
              readOnly={bug.isDeleted}
            />
          </div>
        </div>
        <ImportanceReasons reasons={importanceReasons} />
      </div>

      <div className="flex flex-wrap items-start gap-5">
        {/* MAIN COLUMN */}
        <div className="flex min-w-0 flex-[999_1_600px] flex-col gap-5">
          {/* #1446: the progress report's stage filters the Conversation (#186). */}
          <IssueStageProvider initialStage={currentStage}>
          <EditableIssueDescription
            bugId={bug.id}
            initialTitle={bug.title}
            initialDescription={bug.description}
            canEdit={canEdit}
            users={users}
            lastEditedAt={lastRevision?.editedAt ?? null}
            historyHref={issuePath(bug.number, "/history")}
          >
            {(bug.area || bug.milestone) ? (
              <dl className="mt-4 grid grid-cols-1 gap-3 text-sm text-zk-text2 sm:grid-cols-2">
                {bug.area ? (
                  <div>
                    <dt className="font-medium text-zk-muted">Area</dt>
                    <dd>{bug.area.name}</dd>
                  </div>
                ) : null}
                {bug.milestone ? (
                  <div>
                    <dt className="font-medium text-zk-muted">Milestone</dt>
                    <dd className="flex flex-wrap items-center gap-2">
                      <Link href={milestoneIssuesHref(bug.milestone.id)} className="font-bold text-zk-accent hover:underline">
                        {bug.milestone.title}
                      </Link>
                      <MilestoneDue due={dueDateValue(bug.milestone.dueDate) || null} isClosed={bug.milestone.isClosed} />
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
          </EditableIssueDescription>

          {issueAttachments.length > 0 ? (
            <section className="rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-6">
              <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
                Attachments
              </h2>
              <AttachmentList attachments={issueAttachments} />
            </section>
          ) : null}

          {/* Progress report (#1446), where the summary strip was; its stage drives the Conversation card. */}
          <IssueProgressReport
            decisions={agentDecisions}
            currentStage={currentStage}
            setback={stageSetback(currentStage, bug.reviewStatus)}
          />

              <section
                id="conversation"
                className="scroll-mt-24 rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-[22px]"
              >
                <span id="comments" className="sr-only" aria-hidden="true" />
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
                    Conversation
                  </h2>
                  <DisputeAwardDialog bugNumber={bug.number} roles={disputeRoles} />
                </div>
                {/* Who has the issue, once it is past Requires confirmation: the agent it was awarded to, or Open. */}
                {pastConfirmation ? <AwardBox holds={holds} open={bug.status === "open"} /> : null}
                {/* #186: the picked stage's summary, in place of the Agent decisions card. */}
                <IssueStageSummary
                  decisions={agentDecisions}
                  currentStage={currentStage}
                  setback={stageSetback(currentStage, bug.reviewStatus)}
                  pullRequestUrl={bug.pullRequestUrl}
                  severity={bug.severity}
                  ideaVerdicts={
                    ideaVerdicts
                      ? { score: ideaVerdicts.ideaScore, threshold: ideaVerdicts.ideaThreshold, votes: ideaVerdicts.votes }
                      : undefined
                  }
                  confirmation={confirmation}
                />
                {confirming && confirmationsData ? (
                  <IssueConfirmationsPanel
                    bugId={bug.id}
                    data={confirmationsData}
                    viewerId={user.id}
                    block={confirmationBlock}
                    summaryMaxChars={CONFIRMATION_SUMMARY_MAX_CHARS}
                    confirmed={false}
                  />
                ) : null}
                {testing || testVerdictList.length > 0 ? (
                  <TestVerdictsPanel bugId={bug.id} verdicts={testVerdictList} canReply={testing} history={!testing} />
                ) : null}
                {mergeReviewing || mergeReviewList.length > 0 ? (
                  <MergeReviewsPanel bugId={bug.id} reviews={mergeReviewList} canReply={mergeReviewing} history={!mergeReviewing} />
                ) : null}
                {pastConfirmation ? (
                  <IssueBidsPanel
                    bugId={bug.id}
                    bids={bidList}
                    canAward={canAwardBid && intakeStage === "ready"}
                    canReply={!bug.isDeleted}
                  />
                ) : null}
                <IssueComments
                  count={commentCount}
                  composer={takesComments ? <CommentComposer bugId={bug.id} /> : null}
                  replyBugId={takesComments ? bug.id : undefined}
                  issueUrl={absoluteUrl(issuePath(bug.number))}
                  reporterId={bug.reporterId}
                  comments={commentTree}
                  attachmentsByComment={attachmentsByComment}
                  organizationRoles={organizationRoles}
                  users={commentMentionUsers}
                  currentUserId={user.id}
                  currentUserRole={user.role}
                  tenantAdmin={access.admin}
                  readOnly={bug.isDeleted}
                >
                  {comments.hiddenThreads > 0 ? (
                    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-zk-chip px-3 py-2 text-sm text-zk-text2 print:hidden">
                      <span>
                        {comments.hiddenThreads} earlier{" "}
                        {comments.hiddenThreads === 1 ? "thread" : "threads"} not shown.
                      </span>
                      <Link
                        href={earlierThreadsHref(pageQuery, comments.shownThreads)}
                        scroll={false}
                        className="font-bold text-zk-accent hover:underline"
                      >
                        Show {Math.min(comments.hiddenThreads, COMMENT_THREADS_PER_PAGE)} earlier
                      </Link>
                      {comments.hiddenThreads > COMMENT_THREADS_PER_PAGE ? (
                        <Link
                          href={earlierThreadsHref(pageQuery, comments.shownThreads, true)}
                          scroll={false}
                          className="font-bold text-zk-accent hover:underline"
                        >
                          Show all
                        </Link>
                      ) : null}
                    </div>
                  ) : null}
                </IssueComments>
                {pastConfirmation && confirmationsData && confirmationsData.entries.length > 0 ? (
                  <IssueConfirmationsPanel
                    bugId={bug.id}
                    data={confirmationsData}
                    viewerId={user.id}
                    block={null}
                    summaryMaxChars={CONFIRMATION_SUMMARY_MAX_CHARS}
                    history
                    confirmed
                  />
                ) : null}
                <Suspense fallback={null}>
                  <CommentPermalinkResolver />
                </Suspense>
              </section>

          {canUpdateStatus && !bug.isDeleted ? (
            <UpdateIssueForm
              bugId={bug.id}
              status={bug.status}
              severity={bug.severity}
              typeId={bug.typeId}
              assigneeId={bug.assigneeId}
              categoryId={bug.categoryId}
              areaId={bug.areaId}
              users={users}
              categories={withCurrentOption(categories, bug.category)}
              areas={areas}
              types={withCurrentOption(types, bug.type)}
              milestoneId={bug.milestoneId}
              milestones={
                bug.milestone && !milestoneOptions.some((m) => m.id === bug.milestone?.id)
                  ? [...milestoneOptions, { id: bug.milestone.id, title: bug.milestone.title, isClosed: bug.milestone.isClosed }]
                  : milestoneOptions
              }
              canEditTriage={canTriage}
            />
          ) : null}

          <IssueEscalations escalations={escalations} />

          <Suspense fallback={null}>
            <GoalBudgetSection tenantId={bug.tenantId} projectId={bug.projectId} bugId={bug.id} />
          </Suspense>

          {canDelete && !bug.isDeleted ? (
            <section className="rounded-[20px] border border-zk-bad-bd bg-zk-bad-soft/60 p-4 sm:p-6 print:hidden">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-bad-fg">
                    Danger zone
                  </h2>
                  <p className="text-sm text-zk-text2">
                    Delete this issue. {deleteSummary(keptCounts)}
                  </p>
                </div>
                <DeleteIssueButton
                  bugId={bug.id}
                  bugTitle={bug.title}
                  counts={keptCounts}
                  variant="danger"
                />
              </div>
            </section>
          ) : null}
          </IssueStageProvider>
        </div>

        {/* SIDE RAIL */}
        <aside className="flex min-w-0 flex-[1_1_340px] flex-col gap-4">
          {/* Status: workflow state, when it was opened, and whether it is an idea or an issue (#687). */}
          <section aria-label="Status" className="flex flex-col gap-2.5 rounded-[20px] border border-zk-border bg-zk-surface px-4 py-3.5">
            <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Status</h2>
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-bold">
              {bug.isDeleted ? (
                <span className={`${issueChipBaseClass} bg-zk-bad-bg text-zk-bad-fg`}>Deleted</span>
              ) : null}
              <Badge className={`${issueChipBaseClass} ${issueStatusChipClass[bug.status]}`}>
                <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
                {statusLabels[bug.status]}
              </Badge>
              <ReviewStatusBadge status={bug.reviewStatus} />
              <Badge className={`${issueChipBaseClass} ${issueSeverityChipClass[bug.severity]}`}>
                {severityLabels[bug.severity]}
              </Badge>
              {sourceIdea ? (
                <Link
                  href={ideaPath(sourceIdea.number)}
                  data-testid="source-idea-link"
                  className={`${issueChipBaseClass} bg-zk-chip text-zk-text2 hover:underline`}
                >
                  From idea #{sourceIdea.number}
                </Link>
              ) : null}
              {bug.isBoosted && !bug.isDeleted ? (
                <span className={`${issueChipBaseClass} border border-zk-warn-bd bg-zk-warn-bg text-zk-warn-fg`}>Boosted</span>
              ) : null}
            </div>
            <p className="text-xs text-zk-muted">
              Opened <LocalTime compact date={bug.createdAt} /> by {bug.reporter.name}
            </p>
          </section>

          {/* People, compact: one row each, label on the left. */}
          <section className="flex flex-col gap-2 rounded-[20px] border border-zk-border bg-zk-surface px-4 py-3.5">
            <span className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">People</span>
            <div className="flex min-w-0 items-center gap-3">
              <span className="w-16 shrink-0 text-xs text-zk-muted">Reporter</span>
              <UserNameWithBadges
                name={bug.reporter.name}
                role={bug.reporter.role}
                organizationRole={organizationRoles[bug.reporterId]}
                image={bug.reporter.image}
                avatar="sm"
                userId={bug.reporterId}
                agentName={bug.createdByAgent?.name}
                showAuthor
              />
            </div>
            <div className="flex min-w-0 items-center gap-3">
              <span className="w-16 shrink-0 text-xs text-zk-muted">Assignee</span>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {bug.assignee ? (
                  <UserNameWithBadges
                    name={bug.assignee.name}
                    role={bug.assignee.role}
                    organizationRole={bug.assigneeId ? organizationRoles[bug.assigneeId] : null}
                    image={bug.assignee.image}
                    avatar="sm"
                    userId={bug.assigneeId}
                  />
                ) : (
                  <span className="text-sm text-zk-muted">Unassigned</span>
                )}
                {canSelfAssign ? (
                  <SelfAssignButton
                    bugId={bug.id}
                    isAssignedToMe={isAssignee}
                    variant="ghost"
                    size="xs"
                  />
                ) : null}
              </div>
            </div>
          </section>

          {/* GitHub PR, under People. It lists the linked PR too, so the separate PR box is gone. */}
          <EditableProofLinks
            bugId={bug.id}
            initialLinks={proofLinks}
            linkedPullRequestUrl={bug.pullRequestUrl}
            canEdit={(canEdit || isAssignee) && !bug.isDeleted}
          />

          <SubmissionEvidence
            screenshots={submissionScreenshots}
            testResults={submissionTestResults}
            pullRequestUrl={bug.pullRequestUrl}
          />

          <ActivityTimeline
            activities={[...activities].reverse()}
            totalCount={activityCount}
          />
        </aside>
      </div>
    </div>
  );
}
