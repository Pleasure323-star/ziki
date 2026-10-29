import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { AgentLevel, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { agentErrorResponse, assertKeyProject, requireAgent, type AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { reviewerConflict, ReviewerNotIndependentError, type ReviewedBug } from "@/lib/agents/independence";
import { audit } from "@/lib/agents/audit";
import { consumeAgentBudget, agentBudgetExceededResponse } from "@/lib/agents/rate-budget";
import { withAgentBudgetHeaders, type AgentBudgetQuota } from "@/lib/agents/rate-budget-headers";
import { commentSchema, statusSchema, severitySchema } from "@/lib/validations/issue";
import { parsePlatformFilter, platformFilterWhere } from "@/lib/platform-filter";
import { boundSearchTerm, escapeSearchQuery } from "@/lib/search";
import { parseProjectAreaFilter, projectAreaFilterWhere } from "@/lib/project-area-filter";
import { issueStage, parseIssueStageView, type IssueStage } from "@/lib/issue-stage";
import { eventStreamBus, TENANT_WRITE } from "@/lib/events/stream-bus";
import { parseIssueRef } from "@/lib/issue-ref";
import { cursorOrderBy, cursorWhere, decodeCursor, LIMIT_RANGE_ERROR, pageSize, toPage, type IssueCursor } from "@/lib/agent-api/create-policy";
import { commentedSummary, commentPreview } from "@/lib/activity-log";
import { extractMentionedUserIds, normalizeMentions } from "@/lib/mentions";
import { commentDepth, MAX_COMMENT_DEPTH } from "@/lib/comments";
import { attachmentIdsInMarkdown, linkAttachments } from "@/lib/attachment-link";
import { MAX_ATTACHMENTS_PER_ITEM } from "@/lib/attachments";
import { publish } from "@/lib/agent-api/events";
import { pullRequestAttachment } from "@/lib/github/pr-mention";
import { isConfirmed } from "@/lib/agent-api/confirmations";
import { notifyLater } from "@/lib/notify";
import type { NotificationEvent } from "@/lib/notifications";
import { logger } from "@/lib/logger";
import { REVIEW_STATUSES } from "@/lib/merge-status";
import { IssueApiError } from "@/lib/agent-api/errors";

export { IssueApiError };

const idSchema = z.string().trim().min(1).max(191);
// Ideas are not issues and have no stage here (#idea-table): see /api/v1/ideas.
const stageSchema = z.enum(["confirming", "ready"]);

/** #406: name the bad query parameter instead of returning a pathless Zod dump. */
function enumFilter<T extends string>(name: string, raw: string | null, allowed: readonly T[]): T | null {
  if (!raw) return null;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new IssueApiError(400, `${name} must be one of ${allowed.join(", ")}.`);
  }
  return raw as T;
}

/** Files uploaded with POST /api/v1/attachments, linked on save (#645). */
const attachmentIdsSchema = z.array(idSchema).max(MAX_ATTACHMENTS_PER_ITEM).optional();
const agentCommentSchema = commentSchema.extend({ projectId: idSchema.optional(), attachmentIds: attachmentIdsSchema }).strict();

/**
 * Authenticate before parsing input, charge the shared budget, and audit outcomes including denials.
 *
 * `level` is the agent class the route needs. `"read"` is a route any agent may
 * call that only reads, so it is charged to the read budget rather than write.
 */
export async function agentIssueRequest(
  request: NextRequest, action: string, level: AgentLevel | "read", target: string | null,
  run: (agent: AgentContext) => Promise<Response>,
  // `write` charges a `"read"` route that changes data (#515) to the write budget.
  // `heartbeat` charges the claim-keeping-ping budget instead of write (#556), so an
  // agent at its write cap can still heartbeat the claims it's actively working.
  options: { budget?: "none" | "write" | "heartbeat" } = {},
): Promise<Response> {
  let agent: AgentContext | undefined;
  let response: Response | undefined;
  let quota: AgentBudgetQuota | undefined;
  try {
    agent = await requireAgent(request);
    requireLevel(agent, level === "read" ? "working" : level);
    if (options.budget === "none") {
      // Retired or non-working routes must not spend the caller's budget (#554).
      response = await run(agent);
    } else {
      const budgetKind = options.budget === "heartbeat"
        ? "heartbeat"
        : level === "read" && options.budget !== "write" ? "read" : "write";
      const budget = await consumeAgentBudget(
        { id: agent.agentId, burst: agent.burst, burstUntil: agent.burstUntil ?? null },
        budgetKind,
      );
      quota = budget;
      response = budget.allowed ? await run(agent) : agentBudgetExceededResponse(budget.retryAfterSeconds, budget);
    }
  } catch (error) {
    if (error instanceof IssueApiError) response = NextResponse.json(error.body ? { error: error.message, ...error.body } : { error: error.message }, { status: error.status });
    else if (error instanceof z.ZodError) response = NextResponse.json({ error: "Invalid input.", details: error.issues }, { status: 422 });
    else response = agentErrorResponse(error);
  } finally {
    if (agent) {
      // `request: true` marks the supplementary row so the audit page can hide
      // it by default: the domain audit already records successful writes (#575).
      const payload = { status: response?.status ?? 500, request: true as const };
      try {
        // Required domain audits commit inside the domain transaction. This
        // supplementary request log must not turn a committed write into a failure.
        await audit(agent, action, target, payload);
      } catch (error) {
        // Retain the failed record in server logs for investigation/recovery.
        logger.error("[agent-api] request audit failed", {
          tenantId: agent.tenantId, agentId: agent.agentId, action, target, payload,
        }, error);
      }
    }
  }
  // A committed agent write changes what the work feed lists. Say so now, so
  // the agent's next poll is fresh; the event broadcast follows a moment later.
  if (agent && response.status < 400 && (level !== "read" || options.budget === "write")) {
    eventStreamBus.emit(TENANT_WRITE, agent.tenantId);
  }
  // #646/#596: every charged response — success, validation failure, or a
  // domain error thrown after the charge — reports the same quota.
  if (quota) response = withAgentBudgetHeaders(response, quota);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function issueJson(request: NextRequest): Promise<unknown> {
  try { return await request.json(); }
  catch { throw new IssueApiError(400, "Send a valid JSON body."); }
}

/** The 400 for an issue route called without a project. */
export const PROJECT_ID_REQUIRED =
  "projectId is required. Pass it as ?projectId= or in the JSON body. Your owner can copy it from Settings, under Agents.";

/** Every call names a project; a project id alone never grants access to its tenant. */
export async function issueProject(agent: AgentContext, params: URLSearchParams, bodyProjectId?: string) {
  const queryId = params.get("projectId");
  if (queryId && bodyProjectId && queryId !== bodyProjectId) throw new IssueApiError(400, "Conflicting projectId values.");
  // #563: name the missing parameter instead of a raw validation dump.
  if (!queryId?.trim() && !bodyProjectId?.trim()) throw new IssueApiError(400, PROJECT_ID_REQUIRED);
  const projectId = idSchema.parse(queryId || bodyProjectId);
  const project = await prisma.project.findFirst({ where: { id: projectId, tenantId: agent.tenantId }, select: { id: true } });
  if (!project) throw new IssueApiError(404, "Project not found.");
  // A key issued for one project cannot read or change another (#742).
  assertKeyProject(agent, project.id);
  return { tenantId: agent.tenantId, projectId: project.id };
}

type Scope = { tenantId: string; projectId: string };
export const issueSelect = {
  id: true, number: true, title: true, description: true, status: true, severity: true,
  categoryId: true, typeId: true, reporterId: true, assigneeId: true, beneficiaryUserId: true,
  createdByAgentId: true, projectId: true, areaId: true, createdAt: true, updatedAt: true, proofLinks: true,
  voteCount: true,
  // #idea-table: the idea this issue was converted from.
  idea: { select: { id: true, number: true, score: true, convertedAt: true } },
  // #544: whether a fix is linked, and at which commit. Without these a
  // reviewer cannot tell a linked fix from an unlinked one, and `proofLinks`
  // is misleading because it is free text set at create/edit, not the field
  // the verdict and merge gates read.
  pullRequestUrl: true,
  pullRequestHeadSha: true,
  reviewStatus: true,
  area: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.BugSelect;

/**
 * #409: the shared parsers turn an unknown id into "no filter" so a stale web
 * link shows everything. An API client that sends a mistyped id must be told,
 * not handed the whole backlog.
 */
export function requireKnownFilter(name: "platform" | "area", raw: string | null, parsed: string | null): string | null {
  if (raw?.trim() && parsed === null) {
    throw new IssueApiError(422, `Unknown ${name} id "${raw.trim()}". Use an id from this project, or "none".`);
  }
  return parsed;
}

export async function listAgentIssues(scope: Scope, params: URLSearchParams) {
  const status = enumFilter("status", params.get("status"), statusSchema.options);
  const severity = enumFilter("severity", params.get("severity"), severitySchema.options);
  const assignee = params.get("assignee");
  const stage: IssueStage | null = parseIssueStageView(enumFilter("stage", params.get("stage"), stageSchema.options));
  const reviewStatusParam = params.get("reviewStatus");
  const reviewStatus = enumFilter("reviewStatus", reviewStatusParam, REVIEW_STATUSES);
  let assigneeId: string | null | undefined;
  if (assignee) {
    if (assignee === "none") assigneeId = null;
    else {
      const parsed = idSchema.safeParse(assignee);
      if (!parsed.success) throw new IssueApiError(400, 'assignee must be "none" or a valid user id.');
      assigneeId = parsed.data;
    }
  }
  const platforms = await prisma.category.findMany({
    where: { tenantId: scope.tenantId },
    select: { id: true, name: true },
  });
  const requestedArea = params.get("area");
  const areas = requestedArea
    ? await prisma.projectArea.findMany({ where: { projectId: scope.projectId }, select: { id: true, name: true } })
    : [];
  const cursorRaw = params.get("cursor");
  const cursor = decodeCursor(cursorRaw);
  if (cursorRaw !== null && !cursor) throw new IssueApiError(400, "Invalid cursor.");
  const limit = pageSize(params.get("limit"));
  if (limit === null) throw new IssueApiError(422, LIMIT_RANGE_ERROR);
  const q = params.get("q")?.trim();
  // #460: same escaped, bounded title/description match the app list uses. AND keeps it apart from the cursor's OR.
  const search: Prisma.BugWhereInput = q
    ? { AND: [{ OR: [
        { title: { contains: escapeSearchQuery(boundSearchTerm(q)), mode: "insensitive" } },
        { description: { contains: escapeSearchQuery(boundSearchTerm(q)), mode: "insensitive" } },
      ] }] }
    : {};
  const filtered: Prisma.BugWhereInput = {
    ...scope, isDeleted: false, ...search,
    ...(status ? { status } : {}),
    ...(severity ? { severity } : {}),
    ...(assigneeId !== undefined ? { assigneeId } : {}),
    ...(reviewStatus ? { reviewStatus } : {}),
    ...platformFilterWhere(requireKnownFilter("platform", params.get("platform"), parsePlatformFilter(params.get("platform"), platforms))),
    ...projectAreaFilterWhere(requireKnownFilter("area", requestedArea, parseProjectAreaFilter(requestedArea, areas))),
  };
  if (stage) {
    // #requires-confirmation: a stage is a status now. `confirming` is
    // Requires confirmation and `ready` is Open; with another status, empty.
    const stageStatus = stage === "confirming" ? "requires_confirmation" : "open";
    if (filtered.status && filtered.status !== stageStatus) return { items: [], nextCursor: null };
    filtered.status = stageStatus;
  }
  const where: Prisma.BugWhereInput = { ...filtered, ...cursorWhere(cursor) };
  const rows = await prisma.bug.findMany({ where, orderBy: cursorOrderBy(), take: limit + 1, select: issueSelect });
  return toPage(rows, limit);
}

const confirmationSelect = {
  id: true,
  verdict: true,
  summary: true,
  description: true,
  severity: true,
  duplicateOfId: true,
  agentId: true,
  onBehalfOfUserId: true,
  undoneAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.IssueConfirmationSelect;

export async function readAgentIssue(scope: Scope, id: string) {
  // #457: the path may be the readable number (`123`, `ZE-123`) or the id.
  const ref = parseIssueRef(id);
  const issue = await prisma.bug.findFirst({
    where: { ...scope, ...(ref.kind === "number" ? { number: ref.number } : { id: ref.id }), isDeleted: false },
    select: { ...issueSelect, voteCount: true, comments: {
      where: { deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100,
      select: { id: true, body: true, authorId: true, agentId: true, parentId: true, confirmationId: true, bidId: true, testVerdictId: true, mergeReviewId: true, type: true, metadata: true, createdAt: true, editedAt: true },
    }, attachments: {
      // #645: metadata only; bytes are served to signed-in people at /api/attachments/{id}.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, filename: true, contentType: true, size: true, commentId: true, createdAt: true },
    }, confirmations: {
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: confirmationSelect,
    }, bids: {
      // #issue-bids: the open bids (GET /issues/{id}/bid has their replies).
      where: { withdrawnAt: null, awardedAt: null, agent: { revokedAt: null } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, agentId: true, beneficiaryUserId: true, summary: true, description: true, createdAt: true, updatedAt: true },
    }, _count: { select: { comments: { where: { deletedAt: null } } } } },
  });
  if (!issue) throw new IssueApiError(404, "Issue not found.");
  const confirmed = await isConfirmed(issue.id);
  return {
    ...issue,
    confirmed,
    stage: issueStage({ status: issue.status }),
  };
}

/** What a paged comment carries: the embedded read's fields plus who wrote it. */
const commentSelect = {
  id: true, body: true, authorId: true, agentId: true, parentId: true, confirmationId: true, bidId: true, testVerdictId: true, mergeReviewId: true, type: true, metadata: true, createdAt: true, editedAt: true,
  author: { select: { id: true, name: true } },
  agent: { select: { id: true, name: true } },
} satisfies Prisma.CommentSelect;

/** Comments strictly after `cursor` in the older-first paging order (#604). */
function commentsAfter(cursor: IssueCursor): Prisma.CommentWhereInput {
  return {
    OR: [
      { createdAt: { gt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { gt: cursor.id } },
    ],
  };
}

/**
 * Non-deleted comments on one issue, oldest first, so an agent can read a long
 * thread from the start (the issue read itself keeps returning the latest 100).
 * The cursor is the same shared (createdAt, id) one; `after` returns only newer
 * comments. The result follows the shared list shape: `{ items, nextCursor }`.
 */
export async function listAgentIssueComments(scope: Scope, id: string, params: URLSearchParams) {
  const cursorRaw = params.get("after");
  const cursor = decodeCursor(cursorRaw);
  if (cursorRaw !== null && !cursor) throw new IssueApiError(400, "Invalid cursor.");
  const limit = pageSize(params.get("limit"));
  if (limit === null) throw new IssueApiError(422, LIMIT_RANGE_ERROR);
  const typeParam = params.get("type");
  const validTypes = ["comment", "bid", "review", "delivery", "request_to_merge"];
  if (typeParam && !validTypes.includes(typeParam)) {
    throw new IssueApiError(400, `Unknown comment type: ${typeParam}.`, { validTypes });
  }
  const filterType = typeParam ? (typeParam as Prisma.EnumCommentTypeFilter["equals"]) : undefined;

  const issue = await prisma.bug.findFirst({ where: { ...scope, id, isDeleted: false }, select: { id: true } });
  if (!issue) throw new IssueApiError(404, "Issue not found.");
  const rows = await prisma.comment.findMany({
    where: {
      bugId: id,
      deletedAt: null,
      ...(filterType ? { type: filterType } : {}),
      ...(cursor ? commentsAfter(cursor) : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: commentSelect,
  });
  return toPage(rows, limit);
}

async function normalizeTenantMentions(db: Prisma.TransactionClient, tenantId: string, body: string) {
  const ids = extractMentionedUserIds(body);
  const users = ids.length ? await db.user.findMany({
    where: { id: { in: ids }, memberships: { some: { tenantId } } }, select: { id: true, name: true },
  }) : [];
  return normalizeMentions(body, new Map(users.map((user) => [user.id, user.name])));
}

export async function commentOnAgentIssue(agent: AgentContext, request: NextRequest, bugId: string) {
  const input = agentCommentSchema.parse(await issueJson(request));
  const scope = await issueProject(agent, request.nextUrl.searchParams, input.projectId);
  let bug: ({
    id: string;
    title: string;
    reporterId: string;
    assigneeId: string | null;
    pullRequestUrl: string | null;
    proofLinks: string[];
  } & ReviewedBug) | null = null;
  let parentAuthorId: string | null = null;
  const comment = await prisma.$transaction(async (tx) => {
    bug = await tx.bug.findFirst({
      where: { ...scope, id: bugId, isDeleted: false },
      select: {
        id: true, title: true, reporterId: true, assigneeId: true, beneficiaryUserId: true,
        pullRequestUrl: true, proofLinks: true,
        createdByAgent: { select: { ownerUserId: true } },
        claims: { where: { status: "active", releasedAt: null }, select: { status: true, releasedAt: true, beneficiaryUserId: true, dispatcherUserId: true, agent: { select: { ownerUserId: true } } } },
      },
    });
    if (!bug) throw new IssueApiError(404, "Issue not found.");
    if (input.type === "review") {
      const conflict = reviewerConflict({ id: agent.agentId, ownerUserId: agent.ownerId }, bug);
      if (conflict) throw new IssueApiError(403, "not_independent", { message: new ReviewerNotIndependentError(conflict).message });
    }
    // #issue-confirmations: a reply to a confirmation entry is a plain comment under it.
    if (input.confirmationId) {
      const entry = await tx.issueConfirmation.findFirst({ where: { id: input.confirmationId, bugId }, select: { onBehalfOfUserId: true } });
      if (!entry) throw new IssueApiError(422, "Confirmation not found on this issue.");
      if (input.parentId) throw new IssueApiError(422, "Reply to the confirmation itself: send confirmationId without parentId.");
      if ((input.type ?? "comment") !== "comment") throw new IssueApiError(422, "A reply to a confirmation is a plain comment.");
      parentAuthorId = entry.onBehalfOfUserId;
    }
    // #issue-bids: a reply to a bid is a plain comment under it, too.
    if (input.bidId) {
      if (input.confirmationId) throw new IssueApiError(422, "Reply to one entry: send confirmationId or bidId, not both.");
      const bid = await tx.issueBid.findFirst({ where: { id: input.bidId, bugId }, select: { beneficiaryUserId: true } });
      if (!bid) throw new IssueApiError(422, "Bid not found on this issue.");
      if (input.parentId) throw new IssueApiError(422, "Reply to the bid itself: send bidId without parentId.");
      if ((input.type ?? "comment") !== "comment") throw new IssueApiError(422, "A reply to a bid is a plain comment.");
      parentAuthorId = bid.beneficiaryUserId;
    }
    // #review-entries: a reply to a test verdict or a merge review is a plain comment under it.
    const entryIds = [input.confirmationId, input.bidId, input.testVerdictId, input.mergeReviewId].filter(Boolean);
    if (entryIds.length > 1) {
      throw new IssueApiError(422, "Reply to one entry: send only one of confirmationId, bidId, testVerdictId or mergeReviewId.");
    }
    if (input.testVerdictId) {
      const verdict = await tx.testVerdict.findFirst({ where: { id: input.testVerdictId, bugId }, select: { onBehalfOfUserId: true } });
      if (!verdict) throw new IssueApiError(422, "Test verdict not found on this issue.");
      if (input.parentId) throw new IssueApiError(422, "Reply to the test verdict itself: send testVerdictId without parentId.");
      if ((input.type ?? "comment") !== "comment") throw new IssueApiError(422, "A reply to a test verdict is a plain comment.");
      parentAuthorId = verdict.onBehalfOfUserId;
    }
    if (input.mergeReviewId) {
      const review = await tx.mergeReview.findFirst({ where: { id: input.mergeReviewId, bugId }, select: { onBehalfOfUserId: true } });
      if (!review) throw new IssueApiError(422, "Merge review not found on this issue.");
      if (input.parentId) throw new IssueApiError(422, "Reply to the merge review itself: send mergeReviewId without parentId.");
      if ((input.type ?? "comment") !== "comment") throw new IssueApiError(422, "A reply to a merge review is a plain comment.");
      parentAuthorId = review.onBehalfOfUserId;
    }
    if (input.parentId) {
      const parent = await tx.comment.findFirst({ where: { id: input.parentId, bugId, deletedAt: null }, select: { id: true, authorId: true } });
      if (!parent) throw new IssueApiError(422, "Parent comment not found on this issue.");
      parentAuthorId = parent.authorId;
      const thread = await tx.comment.findMany({ where: { bugId }, select: { id: true, parentId: true } });
      if (commentDepth(parent.id, new Map(thread.map((row) => [row.id, row.parentId]))) >= MAX_COMMENT_DEPTH) {
        throw new IssueApiError(422, "The reply nesting limit has been reached.");
      }
    }
    const body = await normalizeTenantMentions(tx, scope.tenantId, input.body);
    const created = await tx.comment.create({
      data: {
        bugId,
        authorId: agent.ownerId,
        agentId: agent.agentId,
        body,
        parentId: input.parentId ?? null,
        confirmationId: input.confirmationId ?? null,
        bidId: input.bidId ?? null,
        testVerdictId: input.testVerdictId ?? null,
        mergeReviewId: input.mergeReviewId ?? null,
        type: input.type ?? "comment",
        metadata: input.metadata ? (input.metadata as Prisma.InputJsonValue) : undefined,
      },
      select: {
        id: true,
        bugId: true,
        authorId: true,
        agentId: true,
        body: true,
        parentId: true,
        confirmationId: true,
        bidId: true,
        testVerdictId: true,
        mergeReviewId: true,
        type: true,
        metadata: true,
        createdAt: true,
      },
    });
    await linkAgentAttachments(tx, agent, { requested: input.attachmentIds, text: body, bugId, commentId: created.id });
    await tx.bugActivity.create({ data: {
      bugId, actorId: agent.ownerId, type: "commented", summary: commentedSummary(body),
      metadata: { commentId: created.id, commentPreview: commentPreview(body) },
    } });
    let attachedPrUrl: string | null = null;
    const attachment = pullRequestAttachment({
      authorId: agent.ownerId,
      assigneeId: bug.assigneeId,
      pullRequestUrl: bug.pullRequestUrl,
      proofLinks: bug.proofLinks ?? [],
      body,
      type: input.type,
      metadata: input.metadata,
    });
    if (attachment) attachedPrUrl = attachment.pullRequestUrl;
    await tx.bug.update({
      where: { id: bugId },
      data: {
        updatedAt: new Date(),
        ...(attachment ? { pullRequestUrl: attachment.pullRequestUrl } : {}),
        ...(attachment?.proofLinks ? { proofLinks: attachment.proofLinks } : {}),
      },
    });
    if (attachment) {
      await tx.bugActivity.create({
        data: {
          bugId,
          actorId: agent.ownerId,
          type: "edited",
          summary: `linked PR ${attachment.pullRequestUrl}`,
          metadata: { field: "pullRequestUrl", pullRequestUrl: attachment.pullRequestUrl, via: "comment" },
        },
      });
    }
    await tx.issueWatch.upsert({ where: { userId_bugId: { bugId, userId: agent.ownerId } },
      create: { bugId, userId: agent.ownerId }, update: {} });
    await audit(agent, "comment.created", created.id, { authorId: agent.ownerId }, { db: tx, bugId });
    await publish(tx, {
      tenantId: scope.tenantId,
      type: "comment.created",
      payload: {
        commentId: created.id,
        issueId: bugId,
        authorId: agent.ownerId,
        ...(attachment ? { linkedPullRequestUrl: attachment.pullRequestUrl } : {}),
      },
      actorAgentId: agent.agentId,
      bugId,
    });
    return { created, attachedPrUrl };
  });
  notifyAgentComment(agent, bug, comment.created, parentAuthorId);
  return NextResponse.json(
    {
      comment: comment.created,
      ...(comment.attachedPrUrl ? { linkedPullRequestUrl: comment.attachedPrUrl } : {}),
    },
    { status: 201 },
  );
}

/**
 * #533: an agent's comment notifies the same people a person's would:
 * anyone it @mentions, and the issue's watchers (reporter, assignee and
 * watch rows), with a "replied to your comment" for the parent's author.
 * The agent's owner is the actor, so they aren't told about their own agent.
 */
function notifyAgentComment(
  agent: AgentContext,
  bug: { id: string; title: string; reporterId: string; assigneeId: string | null } | null,
  comment: { id: string; body: string },
  parentAuthorId: string | null,
): void {
  if (!bug) return;
  const actor = { actorId: agent.ownerId, actorName: agent.name, bugId: bug.id, bugTitle: bug.title };
  const excerpt = commentPreview(comment.body);
  const mentioned = extractMentionedUserIds(comment.body);
  const events: NotificationEvent[] = [];
  if (mentioned.length > 0) {
    events.push({ ...actor, kind: "mentioned", place: "comment", recipientIds: mentioned, excerpt, commentId: comment.id });
  }
  events.push({
    ...actor,
    kind: "comment_added",
    commentId: comment.id,
    excerpt,
    parentAuthorId,
    recipientIds: [bug.reporterId, bug.assigneeId].filter((id): id is string => Boolean(id)),
    excludeIds: mentioned,
  });
  notifyLater(...events);
}

/**
 * Link uploads to an agent's new issue or comment (#645), the same way the web
 * forms do: only the owner's own uploads that aren't attached anywhere yet
 * can be claimed. Ids the agent named explicitly must all link, or the whole
 * write is refused (422), so an agent never silently loses its evidence.
 * Ids that only appear as /api/attachments/<id> links in the text are best
 * effort, as on the web.
 */
async function linkAgentAttachments(
  tx: Prisma.TransactionClient,
  agent: AgentContext,
  input: { requested?: string[]; text: string; bugId: string; commentId?: string | null },
): Promise<void> {
  const requested = [...new Set(input.requested ?? [])];
  if (requested.length > 0) {
    const linked = await linkAttachments(tx, { ids: requested, uploaderId: agent.ownerId, bugId: input.bugId, commentId: input.commentId ?? null });
    if (linked !== requested.length) {
      throw new IssueApiError(422, "One or more attachmentIds weren't found, belong to someone else, or are already attached.");
    }
  }
  const referenced = attachmentIdsInMarkdown(input.text).filter((id) => !requested.includes(id));
  if (referenced.length > 0) {
    await linkAttachments(tx, { ids: referenced, uploaderId: agent.ownerId, bugId: input.bugId, commentId: input.commentId ?? null });
  }
}
