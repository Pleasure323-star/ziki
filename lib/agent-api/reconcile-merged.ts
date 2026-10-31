import type { Status } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { hasLevel } from "@/lib/agents/levels";
import { reviewerConflict, ReviewerNotIndependentError } from "@/lib/agents/independence";
import { deliveredClaim } from "@/lib/agent-api/merge-verdicts";
import {
  countedReviewers,
  creditedDeliveryUsers,
  finalizeResolved,
  mergeBugSelect,
} from "@/lib/agent-api/merge";
import {
  configuredClientFor,
  parseGitHubRepoUrl,
  parsePullRequestUrl,
  parseRepoFullName,
  sameRepo,
  type GitHubClient,
  type PullRequest,
} from "@/lib/github/merge-pr";

/**
 * A manager reconciles work GitHub already merged (#reconcile-merged).
 *
 * Fixes whose pull requests were merged on GitHub outside Ziki's merge step
 * stayed in review (Delivered, Done or Ready to Merge) and never went Live. An
 * independent manager agent may move such an issue to `resolved` through
 * `POST /issues/{id}/resolve`, once Ziki has checked with GitHub, through the
 * project's GitHub App, that the issue's linked pull request:
 *
 * - is in the project's repository (the URL and GitHub's `base.repo`);
 * - is merged, with a merge commit;
 * - was merged into that repository's default branch.
 *
 * It then finishes the way the merger's admin merge does (`finalizeResolved`):
 * the status and its activity, the claim released, solver, dispatcher and
 * reviewer points, the `issue.accepted` audit row and event. The activity and
 * the audit row carry the pull request, the merge commit and the branch.
 */

/** The steps after delivery, where merged work can be left behind. */
export const RECONCILABLE_STATUSES = ["delivered", "done", "ready_to_merge"] as const satisfies readonly Status[];

/** `via` on the activity and audit row a reconcile writes. */
export const RECONCILE_VIA = "reconcile_merged";

export type ReconcileError =
  | "insufficient_level"
  | "invalid_url"
  | "not_found"
  | "already_resolved"
  | "not_independent"
  | "not_in_review"
  | "no_pull_request"
  | "pr_mismatch"
  | "no_repo"
  | "wrong_repository"
  | "github_unavailable"
  | "github_error"
  | "not_merged"
  | "wrong_branch"
  | "status_changed";

export type ReconcileResult =
  | {
      status: 200;
      body: {
        resolved: true;
        reconciled: true;
        issueId: string;
        previousStatus: string;
        pullRequestUrl: string;
        mergeCommitSha: string;
        baseBranch: string;
        solverUserId: string | null;
        rewardedReviewerUserIds: string[];
      };
    }
  | { status: 403 | 404 | 409 | 422 | 502 | 503; body: { error: ReconcileError; message: string } };

const fail = (status: 403 | 404 | 409 | 422 | 502 | 503, error: ReconcileError, message: string): ReconcileResult =>
  ({ status, body: { error, message } });

const REPAIR_HINT = "If the link points at an old name of the repository, repair it first with POST /api/v1/issues/{id}/pull-request.";

/**
 * Reconcile issue `bugId` (by id) in `scope`. `pullRequestUrl`, when given,
 * must be the linked one. `clientFor` builds the GitHub client; tests pass a
 * fake, and it returns null when the GitHub App isn't configured.
 */
export async function reconcileMergedWork(
  agent: AgentContext,
  scope: { tenantId: string; projectId: string },
  bugId: string,
  pullRequestUrl?: string,
  clientFor: (installationId: string | null | undefined) => GitHubClient | null = configuredClientFor,
): Promise<ReconcileResult> {
  if (!hasLevel(agent.level, "manager")) {
    return fail(403, "insufficient_level", "Only a manager or merger agent can resolve merged work it isn't connected to.");
  }
  if (pullRequestUrl !== undefined && !parsePullRequestUrl(pullRequestUrl)) {
    return fail(422, "invalid_url", "That is not a GitHub pull request URL.");
  }

  const bug = await prisma.bug.findFirst({
    where: { id: bugId, tenantId: scope.tenantId, projectId: scope.projectId, isDeleted: false },
    select: mergeBugSelect,
  });
  if (!bug) return fail(404, "not_found", "No such issue in this project.");
  if (bug.status === "resolved" || bug.status === "closed") {
    return fail(409, "already_resolved", `This issue is already ${bug.status}.`);
  }

  // The same independence rule as a manager's accept and the merge (#493).
  const conflict = reviewerConflict({ id: agent.agentId, ownerUserId: agent.ownerId }, bug);
  if (conflict) return fail(403, "not_independent", new ReviewerNotIndependentError(conflict).message);

  const previousStatus = bug.status;
  if (!(RECONCILABLE_STATUSES as readonly Status[]).includes(previousStatus)) {
    return fail(409, "not_in_review", "Only delivered, done or ready-to-merge work can be reconciled with a merged pull request.");
  }
  if (!bug.pullRequestUrl) return fail(409, "no_pull_request", "This issue has no linked pull request.");
  if (pullRequestUrl !== undefined && pullRequestUrl !== bug.pullRequestUrl) {
    return fail(409, "pr_mismatch", "This issue is linked to a different pull request. Reconcile it with that one.");
  }
  const ref = parsePullRequestUrl(bug.pullRequestUrl);
  if (!ref) return fail(409, "no_pull_request", `The linked address is not a GitHub pull request. ${REPAIR_HINT}`);

  const repo = parseGitHubRepoUrl(bug.project?.repoUrl);
  if (!repo) return fail(422, "no_repo", "This project has no GitHub repository set, so the merge can't be checked.");
  if (!sameRepo(ref, repo)) {
    return fail(422, "wrong_repository", `The linked pull request is not in this project's repository. ${REPAIR_HINT}`);
  }

  const client = clientFor(bug.project?.githubInstallationId);
  if (!client) {
    return fail(503, "github_unavailable", "Ziki can't ask GitHub about this project: the GitHub App isn't configured or installed for it.");
  }
  let pullRequest: PullRequest;
  try {
    pullRequest = await client.getPullRequest(ref);
  } catch {
    return fail(502, "github_error", "GitHub didn't answer. Try again in a minute.");
  }
  if (!pullRequest.merged) return fail(409, "not_merged", "GitHub says the linked pull request isn't merged.");

  const baseRepo = parseRepoFullName(pullRequest.baseRepo);
  if (baseRepo && !sameRepo(baseRepo, repo)) {
    return fail(422, "wrong_repository", "GitHub says the pull request was merged into a different repository.");
  }
  const baseBranch = pullRequest.baseRef;
  const defaultBranch = pullRequest.defaultBranch;
  if (!baseBranch || !defaultBranch || baseBranch !== defaultBranch) {
    const into = baseBranch ? `"${baseBranch}"` : "a branch GitHub didn't name";
    const target = defaultBranch ? `"${defaultBranch}"` : "the default branch";
    return fail(409, "wrong_branch", `The pull request was merged into ${into}, not ${target}, so the fix isn't live.`);
  }
  const mergeCommitSha = pullRequest.mergeCommitSha;
  if (!mergeCommitSha) return fail(409, "not_merged", "GitHub reports no merge commit for the pull request.");

  // Who is credited and paid: the same rules as the merger's admin merge.
  const claim = deliveredClaim(bug);
  const credited = await creditedDeliveryUsers(bug, claim);
  const { reviewers, acceptedHeadSha } = await countedReviewers(bug, claim, credited);
  const solverUserId = claim?.beneficiaryUserId ?? credited[0] ?? bug.assigneeId ?? null;
  const linkedPullRequest = bug.pullRequestUrl;

  const done = await prisma.$transaction(async (tx) => {
    // Re-read inside the transaction: a merge, a reject or another reconcile
    // may have moved the issue, or someone relinked it, since the read above.
    const current = await tx.bug.findUnique({ where: { id: bug.id }, select: { status: true, pullRequestUrl: true } });
    if (!current || current.status !== previousStatus || current.pullRequestUrl !== linkedPullRequest) return false;
    await finalizeResolved(tx, {
      agent,
      bug,
      claim,
      solverUserId,
      rewardedReviewerUserIds: reviewers,
      acceptedHeadSha,
      mergeCommitSha,
      record: { via: RECONCILE_VIA, reconciled: true, baseBranch, mergedOnGitHub: true },
      eventRecord: { via: RECONCILE_VIA, reconciled: true, baseBranch },
    });
    return true;
  });
  if (!done) {
    return fail(409, "status_changed", "This issue's status or linked pull request changed while the request ran. Read it again and retry.");
  }

  return {
    status: 200,
    body: {
      resolved: true,
      reconciled: true,
      issueId: bug.id,
      previousStatus,
      pullRequestUrl: linkedPullRequest,
      mergeCommitSha,
      baseBranch,
      solverUserId,
      rewardedReviewerUserIds: reviewers,
    },
  };
}
