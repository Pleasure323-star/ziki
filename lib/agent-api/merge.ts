import { Prisma } from "@prisma/client";
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
import { statusChangedSummary, commentedSummary, commentPreview } from "@/lib/activity-log";
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
import { recordMistake, type RecordMistakeInput } from "@/lib/agent-api/mistakes";
import { checksProblem, combineProblems, notifyAuthor, readinessProblems } from "@/lib/agent-api/pr-readiness";
import { notifyMergeFailed } from "@/lib/agent-notifications";
import {
  MERGE_BLOCKED,
  MERGE_FAILED,
  recordAcceptBlocked,
  recordMergeOutcome,
  type MergeOutcomeStatus,
} from "@/lib/merge-status";

/**
 * A merger accepting a fix (#434). The gate: the issue is confirmed, no
 * redesign is waiting for a person, and the project's required reviewers whose
 * owners differ said the fix is good to merge. Neither the agent holding the claim
 * nor any agent of the claim holder's owner may be one of those reviewers,
 * and the merger itself must be independent of the fix it accepts (#493):
 * a merger owned by the ticket's beneficiary, reporter, filer, or claim
 * holder can't accept and pay that side.
 *
 * Accepting records the decision on Ziki: it sets the issue to `resolved` and
 * awards points through `award()` (#428) for the solver and for up to two
 * reviewers. It does not merge a git branch (#452).
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

export type AcceptFixResult =
  | {
      status: 200;
      accepted: boolean;
      readyToMerge?: boolean;
      merged?: boolean;
      mergeCommitSha?: string;
      solverUserId?: string | null;
      rewardedReviewerUserIds?: string[];
      notes?: string;
    }
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
    };

export type AcceptFixDeps = {
  client?: GitHubClient | null;
};

export type AcceptFixOptions = {
  verdict?: "accept" | "reject";
  action?: "accept" | "reject";
  notes?: string;
  feedback?: string;
  mistake?: Partial<RecordMistakeInput> & {
    title: string;
    antiPattern: string;
    remediation: string;
  };
};

export async function executeAdminMerge(
  agent: AgentContext,
  bugId: string,
  deps: AcceptFixDeps = {},
  options: AcceptFixOptions = {},
): Promise<AcceptFixResult> {
  if (!hasLevel(agent.level, "merger")) {
    return { status: 403, error: "insufficient_level", message: "Only merger agents can execute the final merge." };
  }
  return acceptFix(agent, bugId, deps, { verdict: "accept", ...options }, true);
}

export async function acceptFix(
  agent: AgentContext,
  bugId: string,
  deps: AcceptFixDeps = {},
  options: AcceptFixOptions = {},
  forceAdminMerge = false,
): Promise<AcceptFixResult> {
  if (!hasLevel(agent.level, "manager")) {
    return { status: 403, error: "insufficient_level", message: "Only manager or merger agents can accept a fix." };
  }

  const bug = await prisma.bug.findFirst({
    where: { id: bugId, tenantId: agent.tenantId, isDeleted: false },
    select: mergeBugSelect,
  });
  if (!bug) return { status: 404, error: "not_found", message: "No such issue in this agent's tenant." };

  const verdict = options.action ?? options.verdict ?? "accept";
  const notes = options.feedback ?? options.notes;

  if (verdict === "reject") {
    const rejectNotes = notes?.trim() || "Fix rejected by merger agent.";
    await prisma.$transaction(async (tx) => {
      await tx.bug.update({
        where: { id: bug.id },
        data: { reviewStatus: "rejected" },
      });
      const comment = await tx.comment.create({
        data: {
          bugId: bug.id,
          authorId: agent.ownerId,
          agentId: agent.agentId,
          body: rejectNotes,
          type: "comment",
        },
        select: { id: true },
      });
      await tx.bugActivity.create({
        data: {
          bugId: bug.id,
          actorId: agent.ownerId,
          type: "commented",
          summary: commentedSummary(rejectNotes),
          metadata: { commentId: comment.id, commentPreview: commentPreview(rejectNotes), rejected: true, reviewStatus: "rejected" },
        },
      });
      // #1429: the issue page lists merge decisions from the audit log, so a
      // rejection needs its own row to show up next to the accepts.
      await audit(
        agent,
        "issue.merge_rejected",
        `bug:${bug.id}`,
        { reviewStatus: "rejected", notes: rejectNotes, pullRequestUrl: bug.pullRequestUrl },
        { bugId: bug.id, db: tx },
      );
      await publish(tx, {
        tenantId: bug.tenantId,
        type: "issue.updated",
        payload: { issueId: bug.id, rejected: true, reviewStatus: "rejected", notes: rejectNotes },
        actorAgentId: agent.agentId,
        bugId: bug.id,
      });

      if (options.mistake) {
        await recordMistake(
          agent,
          bug.projectId,
          {
            ...options.mistake,
            bugId: bug.id,
          },
          tx,
        );
      }
    });
    return { status: 200, accepted: false, notes: rejectNotes };
  }
  // #493: the merger is an independent reviewer too. The same rule that keeps
  // a claim holder's side out of the verdicts keeps it out of the accept —
  // otherwise an owner could accept their own fix and collect the solver
  // points. Checked before anything is written.
  const conflict = reviewerConflict({ id: agent.agentId, ownerUserId: agent.ownerId }, bug);
  if (conflict) {
    return { status: 403, error: "not_independent", message: new ReviewerNotIndependentError(conflict).message };
  }
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
    // accepted otherwise; a comment says why. A merge conflict is the same:
    // no "ready to merge", a comment, and the author is told to resolve it.
    const block = await acceptCheck(githubClientFor(bug, deps), ref, acceptedHeadSha, claim?.agent.name);
    if (block) {
      if (block.missing === "merge_conflict" || block.missing === "review_threads" || block.missing === "deployment_verification") {
        notifyAuthor({ bug, recipientId: claim?.beneficiaryUserId ?? bug.assigneeId, reason: block.message, fromAgentName: agent.name });
      }
      await recordAcceptBlocked(prisma, { agent, bug, reason: block.message, todo: block.todo });
      return { status: 409 as const, error: "not_ready" as const, missing: block.missing, message: block.message };
    }
    return prisma.$transaction(async (tx) => {
      // Merger role: Accepts fix, marks ready to merge without resolving or awarding points
      await tx.bug.update({
        where: { id: bug.id },
        data: { reviewStatus: "ready_to_merge" },
      });
      const acceptCommentBody = "Fix accepted by merger agent. Status changed to ready to merge.";
      await tx.comment.create({
        data: {
          bugId: bug.id,
          authorId: agent.ownerId,
          agentId: agent.agentId,
          body: acceptCommentBody,
          type: "comment",
        },
        select: { id: true },
      });
      await tx.bugActivity.create({
        data: {
          bugId: bug.id,
          actorId: agent.ownerId,
          type: "status_changed",
          summary: "Fix accepted by merger agent and marked ready to merge",
          metadata: { field: "status", readyToMerge: true, headSha: acceptedHeadSha },
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

  // Every way the merge can stop records a merge status and a comment, so the
  // issue says exactly where it is. None of them resolves it or pays points.
  const stop = async (
    status: MergeOutcomeStatus,
    missing: "pull_request" | "deployment_verification" | "github_merge_failed" | "github_app" | "review_threads" | "merge_conflict",
    message: string,
    todo?: string,
  ) => {
    // #1446: a failed check is logged so the issue page lists it under Ready to merge.
    await audit(agent, "github.merge_failed", `bug:${bug.id}`, { reason: message, missing }, { bugId: bug.id, db: prisma });
    await recordMergeOutcome(prisma, { agent, bug, status, reason: message, todo });
    return { status: 409 as const, error: "not_ready" as const, missing, message };
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
  // one comment, and the author is told. A merged pull request is already in,
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

    await tx.bug.update({ where: { id: bug.id }, data: { status: "resolved", reviewStatus: "merged" } });
    await tx.bugActivity.create({
      data: {
        bugId: bug.id,
        actorId: agent.ownerId,
        type: "status_changed",
        summary: statusChangedSummary(bug.status, "resolved"),
        metadata: { field: "status", from: bug.status, to: "resolved" },
      },
    });

    await tx.issueClaim.updateMany({
      where: { bugId: bug.id, status: "active", releasedAt: null },
      data: { status: "released", releasedAt: new Date(), releaseReason: "resolved" },
    });

    const mergeCommentBody = mergeCommitSha
      ? `Merged on GitHub by the admin merger: commit ${mergeCommitSha.slice(0, 7)} of ${bug.pullRequestUrl}.`
      : `Merged on GitHub by the admin merger: ${bug.pullRequestUrl}.`;
    const mergeComment = await tx.comment.create({
      data: {
        bugId: bug.id,
        authorId: agent.ownerId,
        agentId: agent.agentId,
        body: mergeCommentBody,
        type: "comment",
      },
      select: { id: true },
    });
    await tx.bugActivity.create({
      data: {
        bugId: bug.id,
        actorId: agent.ownerId,
        type: "commented",
        summary: commentedSummary(mergeCommentBody),
        metadata: { commentId: mergeComment.id, commentPreview: commentPreview(mergeCommentBody) },
      },
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
    };
  });
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
