import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/agents/audit";
import { reviewerConflict, ReviewerNotIndependentError, type ReviewedBug } from "@/lib/agents/independence";
import { hasLevel } from "@/lib/agents/levels";
import type { AgentContext } from "@/lib/agents/require-agent";
import { IssueApiError } from "@/lib/agent-api/errors";
import { publish } from "@/lib/agent-api/events";
import { isConfirmed } from "@/lib/agent-api/confirmations";
import { countedMergeVerdicts } from "@/lib/agent-api/merge-verdicts";
import { award, awardDispatcher } from "@/lib/points/award";
import { pointSourceKey, reviewerPointsAt } from "@/lib/points/rules";
import {
  calculateReviewerPoints,
  calculateSolverPoints,
} from "@/lib/points/project-rewards";
import { getProjectRewardConfig } from "@/lib/points/platform-rewards";
import { assertRedesignOpen } from "@/lib/redesigns";
import { statusChangedSummary } from "@/lib/activity-log";
import { entryDescription, entryReplySelect, entrySummary, toEntryReplies, type EntryReply } from "@/lib/agent-api/entry-fields";
import { parseIssueRef } from "@/lib/issue-ref";
import { workflowFor } from "@/lib/workflow";
import {
  clientForInstallation,
  isPullRequestClosedUnmerged,
  parseGitHubRepoUrl,
  parsePullRequestUrl,
  sameRepo,
  type GitHubClient,
  type MergePullResult,
  type PullRequest,
} from "@/lib/github/merge-pr";
import { recordMistake, recordMistakeSchema, type RecordMistakeInput } from "@/lib/agent-api/mistakes";
import { checksProblem, combineProblems, notifyAuthor, readinessProblems } from "@/lib/agent-api/pr-readiness";
import { notifyMergeFailed } from "@/lib/agent-notifications";
import { MERGE_BLOCKED, MERGE_FAILED, recordMergeOutcome, type MergeOutcomeStatus } from "@/lib/merge-status";

/**
 * A merger accepting a fix (#434). The gate: the issue is confirmed, no
 * redesign is waiting for a person, and the project's required reviewers whose
 * owners differ said the fix is good to merge. Neither the agent holding the claim
 * nor any agent of the claim holder's owner may be one of those reviewers,
 * and the merger itself must be independent of the fix it accepts (#493):
 * a merger owned by the ticket's beneficiary, reporter, filer, or claim
 * holder can't accept and pay that side.
 *
 * A manager's accept or reject is the Ready to merge stage's entry
 * (#review-entries): a `MergeReview` with a summary of at most two sentences
 * and a full description (a reject's description is the feedback the fix's
 * author acts on). One per agent per issue; reviewing again replaces it.
 * `Bug.reviewStatus` follows it: `ready_to_merge` or `rejected`. Nothing is
 * narrated in comments: the review, the activity log, the audit log and the
 * events are the record.
 *
 * The merger agent's admin merge (`executeAdminMerge`) is an action, not an
 * entry: it merges on GitHub, sets the issue to `resolved` and awards points
 * through `award()` (#428) for the solver and up to two reviewers. Where it
 * stops, the merge status and its reason are on the issue's activity.
 */

const mergeBugSelect = {
  id: true,
  title: true,
  tenantId: true,
  projectId: true,
  pullRequestUrl: true,
  pullRequestHeadSha: true,
  severity: true,
  status: true,
  assigneeId: true,
  beneficiaryUserId: true,
  reporterId: true,
  createdByAgentId: true,
  createdByAgent: { select: { ownerUserId: true } },
  project: { select: { repoUrl: true, githubInstallationId: true } },
  claims: {
    select: {
      status: true,
      releasedAt: true,
      agentId: true,
      beneficiaryUserId: true,
      dispatcherUserId: true,
      agent: { select: { ownerUserId: true, name: true } },
    },
  },
} satisfies Prisma.BugSelect;

type LoadedBug = Prisma.BugGetPayload<{ select: typeof mergeBugSelect }>;
type ActiveClaim = LoadedBug["claims"][number];

/** The claim an agent is currently working `bug` under (#432). */
function activeClaim(bug: LoadedBug): ActiveClaim | null {
  return bug.claims.find((c) => c.status === "active" && !c.releasedAt) ?? null;
}

/** A merge review as the API returns it. */
export type StoredMergeReview = {
  id: string;
  verdict: "accept" | "reject";
  summary: string;
  description: string;
  onBehalfOfUserId: string;
  pullRequestUrl: string;
  headSha: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AcceptFixResult =
  | {
      status: 200;
      accepted: boolean;
      readyToMerge?: boolean;
      merged?: boolean;
      mergeCommitSha?: string;
      solverUserId?: string | null;
      rewardedReviewerUserIds?: string[];
      /** The manager's merge review this call recorded (#review-entries). */
      review?: StoredMergeReview;
      /** The agent had a review on this issue already, and it was replaced. */
      replaced?: boolean;
    }
  | { status: 400; error: "invalid_request"; message: string; field?: string }
  | { status: 403; error: "insufficient_level" | "not_independent"; message: string }
  | { status: 404; error: "not_found"; message: string }
  | {
      status: 409;
      error: "not_ready";
      missing:
        | "already_accepted"
        | "redesign"
        | "confirmation"
        | "verdicts"
        | "claim"
        | "pull_request"
        | "deployment_verification"
        | "github_merge_failed"
        | "github_app"
        | "review_threads"
        | "merge_conflict";
      message: string;
      /** What the fix's author has to do, when the refusal is theirs to fix. */
      todo?: string;
    };

export type AcceptFixDeps = {
  client?: GitHubClient | null;
};

/**
 * The body of `POST /issues/{id}/merge` (#review-entries): the manager's
 * verdict (`accept` or `reject`), a summary of at
 * most two sentences and a full description. A reject may also record an
 * anti-pattern in the project's mistake registry.
 */
export const mergeReviewBodySchema = z.object({
  verdict: z.enum(["accept", "reject"]),
  summary: entrySummary,
  description: entryDescription,
  mistake: recordMistakeSchema.omit({ bugId: true }).optional(),
  projectId: z.string().optional(),
});

export type MergeReviewInput = {
  verdict: "accept" | "reject";
  summary: string;
  description: string;
  mistake?: Omit<RecordMistakeInput, "bugId">;
};

/** Parses a raw `POST /merge` body into a review, or the 400 naming the field. */
export function parseMergeReview(
  raw: unknown,
): { ok: true; review: MergeReviewInput } | { ok: false; error: { status: 400; error: "invalid_request"; message: string; field?: string } } {
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const parsed = mergeReviewBodySchema.safeParse(body);
  if (parsed.success) {
    const { verdict, summary, description, mistake } = parsed.data;
    return { ok: true, review: { verdict, summary, description, ...(mistake ? { mistake } : {}) } };
  }
  const issue = parsed.error.issues[0];
  const field = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
  const message =
    field === "verdict"
      ? 'Send a verdict: "accept" or "reject".'
      : field === "summary" && issue?.code === "invalid_type"
        ? "Add a summary."
        : field === "description" && issue?.code === "invalid_type"
          ? "Add a description: why you accept the fix, or the feedback its author needs to fix it."
          : issue?.message ?? "Invalid merge review.";
  return { ok: false, error: { status: 400, error: "invalid_request", message, ...(field ? { field } : {}) } };
}

const reviewSelect = {
  id: true,
  verdict: true,
  summary: true,
  description: true,
  onBehalfOfUserId: true,
  pullRequestUrl: true,
  headSha: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MergeReviewSelect;

/** Records the agent's merge review on `bug`, replacing its earlier one. */
async function saveMergeReview(
  tx: Prisma.TransactionClient,
  agent: AgentContext,
  bug: { id: string },
  review: MergeReviewInput,
  pullRequestUrl: string,
  headSha: string | null,
): Promise<{ review: StoredMergeReview; replaced: boolean }> {
  const data = {
    verdict: review.verdict,
    summary: review.summary,
    description: review.description,
    onBehalfOfUserId: agent.ownerId,
    pullRequestUrl,
    headSha,
  };
  const existing = await tx.mergeReview.findUnique({
    where: { bugId_agentId: { bugId: bug.id, agentId: agent.agentId } },
    select: { id: true },
  });
  const saved = existing
    ? await tx.mergeReview.update({ where: { id: existing.id }, data, select: reviewSelect })
    : await tx.mergeReview.create({ data: { ...data, bugId: bug.id, agentId: agent.agentId }, select: reviewSelect });
  return { review: saved, replaced: Boolean(existing) };
}

/**
 * The merger agent's admin merge: an action, not an entry. It merges the fix
 * a manager accepted on GitHub, resolves the issue and pays the points.
 */
export async function executeAdminMerge(
  agent: AgentContext,
  bugId: string,
  deps: AcceptFixDeps = {},
): Promise<AcceptFixResult> {
  if (!hasLevel(agent.level, "merger")) {
    return { status: 403, error: "insufficient_level", message: "Only merger agents can execute the final merge." };
  }
  return reviewFix(agent, bugId, deps, null, true);
}

/**
 * `POST /issues/{id}/merge`: a manager agent's merge review, accept or
 * reject. The body must carry a summary and a description (400 otherwise).
 * A merger agent's accept here merges straight away.
 */
export async function acceptFix(
  agent: AgentContext,
  bugId: string,
  deps: AcceptFixDeps = {},
  rawBody: unknown = {},
): Promise<AcceptFixResult> {
  if (!hasLevel(agent.level, "manager")) {
    return { status: 403, error: "insufficient_level", message: "Only manager or merger agents can accept a fix." };
  }
  const parsed = parseMergeReview(rawBody);
  if (!parsed.ok) return parsed.error;
  return reviewFix(agent, bugId, deps, parsed.review, false);
}

async function reviewFix(
  agent: AgentContext,
  bugId: string,
  deps: AcceptFixDeps,
  review: MergeReviewInput | null,
  forceAdminMerge: boolean,
): Promise<AcceptFixResult> {
  const bug = await prisma.bug.findFirst({
    where: { id: bugId, tenantId: agent.tenantId, isDeleted: false },
    select: mergeBugSelect,
  });
  if (!bug) return { status: 404, error: "not_found", message: "No such issue in this agent's tenant." };

  // #493: the merger is an independent reviewer too. The same rule that keeps
  // a claim holder's side out of the verdicts keeps it out of the review —
  // otherwise an owner could accept their own fix and collect the solver
  // points. Checked before anything is written.
  const conflict = reviewerConflict({ id: agent.agentId, ownerUserId: agent.ownerId }, bug);
  if (conflict) {
    return { status: 403, error: "not_independent", message: new ReviewerNotIndependentError(conflict).message };
  }

  if (review?.verdict === "reject") return rejectFix(agent, bug, review);

  if (bug.status === "resolved") {
    return {
      status: 409,
      error: "not_ready",
      missing: "already_accepted",
      message: "This issue's fix has already been accepted.",
    };
  }

  const claim = activeClaim(bug);
  if (!claim) {
    return {
      status: 409,
      error: "not_ready",
      missing: "claim",
      message: "This issue needs an active claim before its fix can be accepted.",
    };
  }
  if (!bug.pullRequestUrl) {
    return {
      status: 409,
      error: "not_ready",
      missing: "pull_request",
      message: "This issue needs a linked pull request before its fix can be accepted.",
    };
  }

  const ref = parsePullRequestUrl(bug.pullRequestUrl);
  const repo = parseGitHubRepoUrl(bug.project?.repoUrl);
  if (ref && repo && !sameRepo(ref, repo)) {
    return {
      status: 409,
      error: "not_ready",
      missing: "pull_request",
      message: "That pull request is not in this project's repository.",
    };
  }

  // #642: a pull request closed without being merged cannot be accepted.
  const isClosed = await isPullRequestClosedUnmerged(
    bug.pullRequestUrl,
    bug.project?.githubInstallationId,
    deps.client,
  );
  if (isClosed) {
    return {
      status: 409,
      error: "not_ready",
      missing: "pull_request",
      message: "That pull request is closed without being merged.",
    };
  }
  const reviewed: ReviewedBug = bug;

  try {
    await assertRedesignOpen(bug.id);
  } catch (error) {
    if (error instanceof IssueApiError) {
      return {
        status: 409 as const,
        error: "not_ready" as const,
        missing: "redesign" as const,
        message: error.message,
      };
    }
    throw error;
  }

  if (!(await isConfirmed(bug.id))) {
    return {
      status: 409 as const,
      error: "not_ready" as const,
      missing: "confirmation" as const,
      message: "This issue isn't confirmed yet: the project's required independent reviewers must accept it as real.",
    };
  }

  const verdicts = await prisma.testVerdict.findMany({
    // #526: only verdicts on the pull request linked now count; one on an
    // earlier PR, or with none, says nothing about this code.
    where: { bugId: bug.id, goodToMerge: true, pullRequestUrl: bug.pullRequestUrl ?? "" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, headSha: true, onBehalfOfUserId: true, agent: { select: { id: true, ownerUserId: true } } },
  });

  // Checked again now, not only when submitted: a claim taken since, or a
  // verdict from the claim holder's own side, no longer counts. #489: the
  // acceptance is bound to the code the reviewers signed off on.
  const { reviewers, acceptedHeadSha } = countedMergeVerdicts(verdicts, claim, reviewed, bug.pullRequestHeadSha ?? null);

  const { verdictsNeeded } = await workflowFor(bug.projectId);
  if (reviewers.length < verdictsNeeded) {
    return {
      status: 409 as const,
      error: "not_ready" as const,
      missing: "verdicts" as const,
      message: `This needs ${verdictsNeeded} reviewers saying it is good to merge; ${reviewers.length} count so far.`,
    };
  }

  const rewardedReviewerUserIds = reviewers;
  const solverUserId = claim?.beneficiaryUserId ?? bug.assigneeId;
  const isAdminMerge = forceAdminMerge || agent.level === "merger";

  if (!isAdminMerge) {
    // Before a manager says yes, GitHub has to say the fix won't break the
    // code: no conflict with the base branch, checks green on the commit the testers approved. Nothing is
    // accepted otherwise; the caller is told why. A merge conflict is the same:
    // no "ready to merge", and the author is told to resolve it.
    const block = await acceptCheck(githubClientFor(bug, deps), ref, acceptedHeadSha, claim?.agent.name);
    if (block) {
      if (block.missing === "merge_conflict" || block.missing === "review_threads" || block.missing === "deployment_verification") {
        notifyAuthor({ bug, recipientId: claim?.beneficiaryUserId ?? bug.assigneeId, reason: block.message, fromAgentName: agent.name });
      }
      // #review-entries: nothing is posted on the issue; the caller gets the
      // reason and what to do.
      return { status: 409 as const, error: "not_ready" as const, missing: block.missing, message: block.message, todo: block.todo };
    }
    const pullRequestUrl = bug.pullRequestUrl;
    return prisma.$transaction(async (tx) => {
      // The manager's accept: ready to merge, without resolving or awarding points.
      const saved = await saveMergeReview(tx, agent, bug, review ?? DEFAULT_ACCEPT, pullRequestUrl, acceptedHeadSha);
      await tx.bug.update({
        where: { id: bug.id },
        data: { reviewStatus: "ready_to_merge" },
      });
      await tx.bugActivity.create({
        data: {
          bugId: bug.id,
          actorId: agent.ownerId,
          type: "status_changed",
          summary: "Fix accepted by merger agent and marked ready to merge",
          metadata: { field: "status", readyToMerge: true, headSha: acceptedHeadSha, mergeReviewId: saved.review.id },
        },
      });
      await audit(
        agent,
        "issue.accepted",
        `bug:${bug.id}`,
        {
          solverUserId,
          rewardedReviewerUserIds,
          pullRequestUrl: bug.pullRequestUrl,
          headSha: acceptedHeadSha,
          readyToMerge: true,
          reviewStatus: "ready_to_merge",
          mergeReviewId: saved.review.id,
          summary: saved.review.summary,
        },
        { bugId: bug.id, db: tx },
      );
      await publish(tx, {
        tenantId: bug.tenantId,
        type: "issue.updated",
        payload: {
          issueId: bug.id,
          solverUserId,
          rewardedReviewerUserIds,
          pullRequestUrl: bug.pullRequestUrl,
          headSha: acceptedHeadSha,
          readyToMerge: true,
          reviewStatus: "ready_to_merge",
          mergeReviewId: saved.review.id,
          summary: saved.review.summary,
        },
        actorAgentId: agent.agentId,
        bugId: bug.id,
      });

      return {
        status: 200 as const,
        accepted: true as const,
        readyToMerge: true as const,
        solverUserId,
        rewardedReviewerUserIds,
        review: saved.review,
        replaced: saved.replaced,
      };
    });
  }

  // Admin merger role: Finalizes resolution, awards points, and releases claim
  // Must strictly verify GitHub state and execute the merge BEFORE resolving or disbursing points.
  if (!ref) {
    return {
      status: 409 as const,
      error: "not_ready" as const,
      missing: "pull_request" as const,
      message: "No pull request is linked to this issue.",
    };
  }

  const ghClient = githubClientFor(bug, deps);

  // Every way the merge can stop records a merge status with its reason on the
  // issue's activity, so the issue says exactly where it is. None of them
  // resolves it or pays points.
  const stop = async (
    status: MergeOutcomeStatus,
    missing: "pull_request" | "deployment_verification" | "github_merge_failed" | "github_app" | "review_threads" | "merge_conflict",
    message: string,
    todo?: string,
  ) => {
    // #1446: a failed check is logged so the issue page lists it under Ready to merge.
    await audit(agent, "github.merge_failed", `bug:${bug.id}`, { reason: message, missing, ...(todo ? { todo } : {}) }, { bugId: bug.id, db: prisma });
    await recordMergeOutcome(prisma, { agent, bug, status, reason: message, todo });
    return { status: 409 as const, error: "not_ready" as const, missing, message, ...(todo ? { todo } : {}) };
  };

  // Without a GitHub client nothing can be checked or merged, so the merge
  // stops here instead of marking the issue merged.
  if (!ghClient) {
    return stop(
      MERGE_BLOCKED,
      "github_app",
      "The GitHub App is not set up for this project, so Ziki can't check or merge the pull request.",
      GITHUB_APP_TODO,
    );
  }

  // 1. Verify PR state directly from GitHub
  let pullRequest: PullRequest;
  try {
    pullRequest = await ghClient.getPullRequest(ref);
  } catch (error) {
    const detail = error instanceof Error && error.message ? error.message : "GitHub could not be reached to verify the pull request.";
    const message = detail.startsWith("GitHub could not be reached")
      ? detail
      : `GitHub could not be reached to verify the pull request: ${detail}`;
    return stop(MERGE_BLOCKED, "deployment_verification", message);
  }

  if (pullRequest.state === "closed" && !pullRequest.merged) {
    return stop(MERGE_BLOCKED, "pull_request", "That pull request is closed without being merged.");
  }

  const headToVerify = acceptedHeadSha || pullRequest.headSha;
  if (pullRequest.headSha && headToVerify && pullRequest.headSha !== headToVerify) {
    return stop(
      MERGE_BLOCKED,
      "pull_request",
      "The pull request's head commit changed since verification. Please re-review.",
      "Testers check the new commit and report again, then a manager accepts it again. Ziki only merges the exact commit the testers approved.",
    );
  }

  // 2. The fix must not break the code and must be ready to go: every check
  // on the head commit green, CodeRabbit's threads resolved, no conflict with
  // the base branch. The same three things testers and managers check; they
  // are read again here because time has passed. Every problem is listed in
  // one reason, and the author is told. A merged pull request is already in,
  // so only its checks are read.
  if (pullRequest.merged) {
    const checks = combineProblems(
      [await checksProblem(ghClient, ref, headToVerify)].filter((problem) => problem !== null),
    );
    if (checks) return stop(MERGE_BLOCKED, checks.missing, checks.message, checks.todo);
  } else {
    const block = combineProblems(await readinessProblems(ghClient, ref, pullRequest, headToVerify, claim?.agent.name));
    if (block) {
      notifyAuthor({ bug, recipientId: claim?.beneficiaryUserId ?? bug.assigneeId, reason: block.message, fromAgentName: agent.name });
      return stop(MERGE_BLOCKED, block.missing, block.message, block.todo);
    }
  }

  // The merge commit comes only from GitHub's answer, never from the request.
  let mergeCommitSha: string | null;

  // 3. Execute GitHub merge if not already merged
  if (!pullRequest.merged) {
    let mergeResult: MergePullResult;
    try {
      mergeResult = await ghClient.mergePullRequest(ref, headToVerify);
    } catch {
      mergeResult = { merged: false };
    }

    if (!mergeResult.merged) {
      const detailSuffix = mergeResult.message ? `: ${mergeResult.message}` : ".";
      const failureReason = mergeResult.conflict
        ? `The pull request changed after its checks were verified${detailSuffix}`
        : mergeResult.forbidden
          ? `The app is not allowed to merge this repository${detailSuffix}`
          : mergeResult.noAllowedMethod
            ? `The repository allows no merge method the app can use${detailSuffix}`
            : (mergeResult.message ? `GitHub refused the merge: ${mergeResult.message}` : "GitHub refused the merge.");

      await publish(prisma, {
        tenantId: bug.tenantId,
        type: "github.merge_failed",
        payload: { issueId: bug.id, reason: failureReason, pullRequestUrl: bug.pullRequestUrl },
        actorAgentId: agent.agentId,
        bugId: bug.id,
      });

      const recipient = claim?.beneficiaryUserId ?? bug.assigneeId ?? null;
      if (recipient) {
        notifyMergeFailed({
          bugId: bug.id,
          bugTitle: bug.title,
          recipientId: recipient,
          reason: failureReason,
          agent: { name: agent.name },
        });
      }

      return stop(MERGE_FAILED, "github_merge_failed", failureReason);
    }

    mergeCommitSha = mergeResult.sha ?? null;
  } else {
    mergeCommitSha = pullRequest.headSha ?? null;
  }

  return prisma.$transaction(async (tx) => {
    const current = await tx.bug.findUnique({
      where: { id: bug.id },
      select: { status: true },
    });
    if (current?.status === "resolved") {
      return {
        status: 409 as const,
        error: "not_ready" as const,
        missing: "already_accepted" as const,
        message: "This issue's fix has already been accepted.",
      };
    }

    // A merger agent's accept through POST /merge is its review too.
    const saved = review ? await saveMergeReview(tx, agent, bug, review, bug.pullRequestUrl!, acceptedHeadSha) : null;
    await tx.bug.update({ where: { id: bug.id }, data: { status: "resolved", reviewStatus: "merged" } });
    // #review-entries: the merge is recorded here, not in a comment.
    await tx.bugActivity.create({
      data: {
        bugId: bug.id,
        actorId: agent.ownerId,
        type: "status_changed",
        summary: statusChangedSummary(bug.status, "resolved"),
        metadata: {
          field: "status",
          from: bug.status,
          to: "resolved",
          reviewStatus: "merged",
          pullRequestUrl: bug.pullRequestUrl,
          mergeCommitSha,
          ...(saved ? { mergeReviewId: saved.review.id } : {}),
        },
      },
    });

    await tx.issueClaim.updateMany({
      where: { bugId: bug.id, status: "active", releasedAt: null },
      data: { status: "released", releasedAt: new Date(), releaseReason: "resolved" },
    });


    const rewardConfig = await getProjectRewardConfig(tx, bug.projectId);
    if (solverUserId) {
      await award(tx, {
        tenantId: bug.tenantId,
        userId: solverUserId,
        bugId: bug.id,
        role: "solver",
        points: calculateSolverPoints(bug.severity, rewardConfig),
        sourceKey: pointSourceKey("solver", bug.id, solverUserId),
      });
    }
    await awardDispatcher(tx, bug, claim.dispatcherUserId);
    const reviewerPoints = calculateReviewerPoints(rewardConfig);
    for (const [index, userId] of rewardedReviewerUserIds.entries()) {
      await award(tx, {
        tenantId: bug.tenantId,
        userId,
        bugId: bug.id,
        role: "reviewer",
        points: reviewerPointsAt(index, reviewerPoints),
        sourceKey: pointSourceKey("reviewer", bug.id, userId),
      });
    }

    await audit(
      agent,
      "issue.accepted",
      `bug:${bug.id}`,
      {
        solverUserId,
        rewardedReviewerUserIds,
        pullRequestUrl: bug.pullRequestUrl,
        headSha: acceptedHeadSha,
        mergeCommitSha,
        merged: true,
        ...(saved ? { mergeReviewId: saved.review.id } : {}),
      },
      { bugId: bug.id, db: tx },
    );
    await publish(tx, {
      tenantId: bug.tenantId,
      type: "issue.accepted",
      payload: {
        issueId: bug.id,
        solverUserId,
        rewardedReviewerUserIds,
        pullRequestUrl: bug.pullRequestUrl,
        headSha: acceptedHeadSha,
        mergeCommitSha,
        status: "resolved",
        reviewStatus: "merged",
      },
      actorAgentId: agent.agentId,
      bugId: bug.id,
    });

    return {
      status: 200 as const,
      accepted: true as const,
      merged: true as const,
      mergeCommitSha: mergeCommitSha ?? undefined,
      solverUserId,
      rewardedReviewerUserIds,
      ...(saved ? { review: saved.review, replaced: saved.replaced } : {}),
    };
  });
}

/** Unreachable in practice: a manager's accept always comes through `acceptFix` with its review. */
const DEFAULT_ACCEPT: MergeReviewInput = {
  verdict: "accept",
  summary: "Accepted for merging.",
  description: "Accepted without a written review.",
};

/**
 * A manager's reject (#review-entries): the merge review carries the
 * feedback, the issue goes back to `rejected`, and an anti-pattern may go in
 * the mistake registry. It needs the pull request it rejects.
 */
async function rejectFix(agent: AgentContext, bug: LoadedBug, review: MergeReviewInput): Promise<AcceptFixResult> {
  if (bug.status === "resolved") {
    return {
      status: 409,
      error: "not_ready",
      missing: "already_accepted",
      message: "This issue's fix has already been merged, so it can't be rejected.",
    };
  }
  const pullRequestUrl = bug.pullRequestUrl;
  if (!pullRequestUrl) {
    return {
      status: 409,
      error: "not_ready",
      missing: "pull_request",
      message: "This issue has no linked pull request to review.",
    };
  }
  const saved = await prisma.$transaction(async (tx) => {
    const saved = await saveMergeReview(tx, agent, bug, review, pullRequestUrl, bug.pullRequestHeadSha ?? null);
    await tx.bug.update({ where: { id: bug.id }, data: { reviewStatus: "rejected" } });
    await tx.bugActivity.create({
      data: {
        bugId: bug.id,
        actorId: agent.ownerId,
        type: "status_changed",
        summary: `Fix rejected for merging: ${review.summary}`,
        metadata: { field: "reviewStatus", reviewStatus: "rejected", rejected: true, mergeReviewId: saved.review.id },
      },
    });
    // #1429: the audit log keeps every merge decision, the review only the latest.
    await audit(
      agent,
      "issue.merge_rejected",
      `bug:${bug.id}`,
      {
        reviewStatus: "rejected",
        mergeReviewId: saved.review.id,
        summary: review.summary,
        notes: review.description,
        pullRequestUrl,
        headSha: saved.review.headSha,
      },
      { bugId: bug.id, db: tx },
    );
    await publish(tx, {
      tenantId: bug.tenantId,
      type: "issue.updated",
      payload: {
        issueId: bug.id,
        rejected: true,
        reviewStatus: "rejected",
        mergeReviewId: saved.review.id,
        summary: review.summary,
        notes: review.description,
      },
      actorAgentId: agent.agentId,
      bugId: bug.id,
    });
    if (review.mistake) {
      await recordMistake(agent, bug.projectId, { ...review.mistake, bugId: bug.id }, tx);
    }
    return saved;
  });
  return { status: 200, accepted: false, review: saved.review, replaced: saved.replaced };
}

/** One merge review as the API and the issue page show it, with its replies. */
export type MergeReviewEntry = StoredMergeReview & {
  agentId: string;
  agentName: string;
  /** The agent's owner, for whom it reviewed. */
  by: string;
  /** On the pull request (and head commit, when both are known) linked now. */
  current: boolean;
  replies: EntryReply[];
};

/** Every merge review on one issue, newest first. */
export async function mergeReviewEntries(
  bug: { id: string; pullRequestUrl: string | null; pullRequestHeadSha: string | null },
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<MergeReviewEntry[]> {
  const rows = await db.mergeReview.findMany({
    where: { bugId: bug.id },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: {
      ...reviewSelect,
      agentId: true,
      agent: { select: { name: true } },
      onBehalfOf: { select: { name: true } },
      replies: entryReplySelect,
    },
  });
  return rows.map(({ agent, onBehalfOf, replies, ...row }) => ({
    ...row,
    agentName: agent.name,
    by: onBehalfOf.name ?? "A member",
    current:
      row.pullRequestUrl === bug.pullRequestUrl &&
      (!bug.pullRequestHeadSha || !row.headSha || row.headSha === bug.pullRequestHeadSha),
    replies: toEntryReplies(replies),
  }));
}

/** GET /issues/{id}/merge-reviews: the issue's merge reviews, each with its replies. */
export async function listMergeReviews(scope: { tenantId: string; projectId?: string }, issueRef: string) {
  const ref = parseIssueRef(issueRef);
  const bug = await prisma.bug.findFirst({
    where: { ...scope, isDeleted: false, ...(ref.kind === "number" ? { number: ref.number } : { id: ref.id }) },
    select: { id: true, number: true, reviewStatus: true, pullRequestUrl: true, pullRequestHeadSha: true },
  });
  if (!bug) throw new IssueApiError(404, "Issue not found.", { error: "not_found", message: "Issue not found." });
  return {
    issueId: bug.id,
    issueNumber: bug.number,
    reviewStatus: bug.reviewStatus,
    pullRequestUrl: bug.pullRequestUrl,
    headSha: bug.pullRequestHeadSha,
    reviews: await mergeReviewEntries(bug),
  };
}

const GITHUB_APP_TODO =
  "A tenant admin installs the Ziki GitHub App on this project's repository and sets the repository on the project. Then try again.";

/** The GitHub client for this issue's project, or null when the app isn't set up. */
function githubClientFor(bug: LoadedBug, deps: AcceptFixDeps): GitHubClient | null {
  if (deps.client !== undefined) return deps.client;
  const hasAppConfig = Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY);
  return hasAppConfig ? clientForInstallation(bug.project?.githubInstallationId) : null;
}

/**
 * What stops a manager from accepting a fix: GitHub can't be asked, the pull
 * request moved after the testers approved it, its checks are not green, it
 * conflicts with its base branch, or CodeRabbit has unresolved review threads.
 * Null when the fix is safe to accept.
 */
async function acceptCheck(
  client: GitHubClient | null,
  ref: ReturnType<typeof parsePullRequestUrl>,
  acceptedHeadSha: string | null,
  author?: string,
): Promise<{
  missing: "pull_request" | "deployment_verification" | "github_app" | "merge_conflict" | "review_threads";
  message: string;
  todo: string;
} | null> {
  if (!client) {
    return {
      missing: "github_app",
      message: "The GitHub App is not set up for this project, so Ziki can't check that the fix won't break the code.",
      todo: GITHUB_APP_TODO,
    };
  }
  if (!ref) {
    return {
      missing: "pull_request",
      message: "The linked address is not a GitHub pull request, so Ziki can't check it.",
      todo: "Link the pull request again with its GitHub address (POST /issues/{id}/github).",
    };
  }
  let pullRequest: PullRequest;
  try {
    pullRequest = await client.getPullRequest(ref);
  } catch {
    return {
      missing: "deployment_verification",
      message: "GitHub could not be reached to check the pull request.",
      todo: "Nothing is wrong with the fix. Try accepting again in a few minutes.",
    };
  }
  if (pullRequest.headSha && acceptedHeadSha && pullRequest.headSha !== acceptedHeadSha) {
    return {
      missing: "pull_request",
      message: "The pull request's head commit changed after the testers approved it.",
      todo: "Testers check the new commit and report again. Then a manager can accept it.",
    };
  }
  return combineProblems(await readinessProblems(client, ref, pullRequest, acceptedHeadSha || pullRequest.headSha, author));
}
