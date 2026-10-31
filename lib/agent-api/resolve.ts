import { prisma } from "@/lib/prisma";
import { issueIdFor } from "@/lib/issue-ref";
import { audit } from "@/lib/agents/audit";
import type { AgentContext } from "@/lib/agents/require-agent";
import { publish } from "@/lib/agent-api/events";
import { statusChangedSummary, unboostedSummary } from "@/lib/activity-log";
import { AGENT_RESOLVE_VIA } from "@/lib/agent-resolution";
import { hasLevel } from "@/lib/agents/levels";
import { reconcileMergedWork, type ReconcileResult } from "@/lib/agent-api/reconcile-merged";
import {
  clientForInstallation,
  configuredClientFor,
  parseGitHubRepoUrl,
  parsePullRequestUrl,
  sameRepo,
  type GitHubClient,
} from "@/lib/github/merge-pr";

/**
 * Ziki #515: any agent may resolve an issue whose fix is already merged, so a
 * fixed issue doesn't wait for a person or a merger. #474 does this for a PR
 * linked through a claim; this covers the rest, such as an issue assigned to a
 * person, where no agent can hold a claim to link it (#494).
 *
 * Guards: the agent's owner must be connected to the issue, and Ziki checks
 * with GitHub that the pull request is merged into the project's repo. No
 * points are written: they still follow the review gates or a person
 * resolving the issue, as in #474.
 *
 * One route, two ways in (#reconcile-merged): an agent whose owner is not
 * connected to the issue may still resolve it if it is a manager or merger
 * agent independent of the issue. That is a manager reconciling work GitHub
 * already merged (lib/agent-api/reconcile-merged.ts): stricter checks (the
 * linked pull request, merged into the default branch, with a merge commit),
 * and it finishes like the merger's admin merge, points included.
 */

export type ResolveResult =
  | { status: 200; body: { resolved: true; issueId: string; previousStatus: string; pullRequestUrl: string } }
  | { status: 403 | 404 | 409 | 422 | 502; body: { error: string; message: string } }
  | ReconcileResult;

const fail = (status: 403 | 404 | 409 | 422 | 502, error: string, message: string): ResolveResult =>
  ({ status, body: { error, message } });

export async function resolveMergedFix(
  agent: AgentContext,
  scope: { tenantId: string; projectId: string },
  issueRef: string,
  /** The merged pull request; the issue's linked one when left out. */
  requestedUrl?: string,
  /** Builds the GitHub client; tests pass a fake. */
  clientFor?: (installationId: string | null | undefined) => GitHubClient | null,
): Promise<ResolveResult> {
  if (requestedUrl !== undefined && !parsePullRequestUrl(requestedUrl)) {
    return fail(422, "invalid_url", "That is not a GitHub pull request URL.");
  }

  // #457: the path may be the readable number (`123`, `ZE-123`) or the id.
  const bugId = await issueIdFor(prisma, issueRef, scope.tenantId);
  if (!bugId) return fail(404, "not_found", "No such issue in this project.");
  const bug = await prisma.bug.findFirst({
    where: { id: bugId, ...scope, isDeleted: false },
    select: {
      id: true, status: true, assigneeId: true, reporterId: true, pullRequestUrl: true, isBoosted: true,
      project: { select: { repoUrl: true, githubInstallationId: true } },
      claims: {
        where: { status: "active", releasedAt: null },
        select: { id: true, agentId: true, beneficiaryUserId: true },
      },
    },
  });
  if (!bug) return fail(404, "not_found", "No such issue in this project.");
  if (bug.status === "resolved" || bug.status === "closed") {
    return fail(409, "already_resolved", `This issue is already ${bug.status}.`);
  }

  const connected =
    bug.assigneeId === agent.ownerId ||
    bug.reporterId === agent.ownerId ||
    bug.claims.some((claim) => claim.beneficiaryUserId === agent.ownerId);
  if (!connected) {
    // A manager independent of the issue reconciles merged work instead.
    if (hasLevel(agent.level, "manager")) {
      return reconcileMergedWork(agent, scope, bugId, requestedUrl, clientFor ?? configuredClientFor);
    }
    return fail(403, "not_connected", "Only an agent whose owner is this issue's assignee, reporter or claim holder, or an independent manager agent, can resolve it.");
  }

  const pullRequestUrl = requestedUrl ?? bug.pullRequestUrl;
  if (!pullRequestUrl) return fail(409, "no_pull_request", "Send the merged pull request's URL: this issue has none linked.");
  const ref = parsePullRequestUrl(pullRequestUrl);
  if (!ref) return fail(422, "invalid_url", "The linked address is not a GitHub pull request URL.");

  // A different linked PR is what reviewers looked at; resolving with another
  // merged PR would close the issue on code nobody tied to it.
  if (bug.pullRequestUrl && bug.pullRequestUrl !== pullRequestUrl) {
    return fail(409, "pr_mismatch", "This issue is linked to a different pull request. Resolve it with that one.");
  }

  const repo = parseGitHubRepoUrl(bug.project?.repoUrl);
  if (!repo) return fail(422, "no_repo", "This project has no GitHub repository set, so the merge can't be checked.");
  if (!sameRepo(ref, repo)) return fail(422, "wrong_repo", "That pull request is not in this project's repository.");

  const client = (clientFor ?? clientForInstallation)(bug.project?.githubInstallationId);
  if (!client) return fail(409, "github_unavailable", "Ziki can't read pull requests for this project: its GitHub App isn't installed.");
  const pullRequest = await client.getPullRequest(ref).catch(() => null);
  if (!pullRequest) return fail(502, "github_error", "GitHub didn't answer. Try again in a minute.");
  if (!pullRequest.merged) return fail(409, "not_merged", "That pull request isn't merged yet.");

  const resolved = await prisma.$transaction(async (tx) => {
    // Only from the status and linked PR read above: someone may have changed
    // the status (the activity records `from`) or linked another PR since,
    // and the pr_mismatch check above only saw the old link.
    const changed = await tx.bug.updateMany({
      where: { id: bug.id, status: bug.status, pullRequestUrl: bug.pullRequestUrl },
      data: {
        status: "resolved",
        // #256: a finished issue shouldn't stay pinned above open work.
        ...(bug.isBoosted ? { isBoosted: false, boostedAt: null } : {}),
        ...(bug.pullRequestUrl ? {} : { pullRequestUrl }),
      },
    });
    if (changed.count !== 1) return false;

    await tx.bugActivity.create({
      data: {
        bugId: bug.id,
        actorId: agent.ownerId,
        type: "status_changed",
        summary: statusChangedSummary(bug.status, "resolved"),
        metadata: {
          field: "status", from: bug.status, to: "resolved",
          via: AGENT_RESOLVE_VIA, agentId: agent.agentId, agentName: agent.name, pullRequestUrl,
        },
      },
    });
    if (bug.isBoosted) {
      await tx.bugActivity.create({
        data: {
          bugId: bug.id, actorId: agent.ownerId, type: "unboosted",
          summary: unboostedSummary(), metadata: { field: "isBoosted", to: "false" },
        },
      });
    }
    await tx.issueClaim.updateMany({
      where: { bugId: bug.id, status: "active", releasedAt: null },
      data: { status: "released", releasedAt: new Date(), releaseReason: "resolved" },
    });
    for (const claim of bug.claims) {
      await publish(tx, {
        tenantId: scope.tenantId, type: "claim.released", actorAgentId: claim.agentId, bugId: bug.id,
        payload: { claimId: claim.id, issueId: bug.id, beneficiaryUserId: claim.beneficiaryUserId, reason: "resolved" },
      });
    }
    await audit(agent, "issue.resolved", `bug:${bug.id}`, { from: bug.status, pullRequestUrl }, { bugId: bug.id, db: tx });
    await publish(tx, {
      tenantId: scope.tenantId, type: "issue.updated", actorAgentId: agent.agentId, bugId: bug.id,
      payload: {
        issueId: bug.id, projectId: scope.projectId, changed: ["status"], values: { status: "resolved" },
        source: "agent", agentId: agent.agentId, pullRequestUrl,
      },
    });
    return true;
  });
  if (!resolved) return fail(409, "status_changed", "This issue's status or linked pull request changed while the request ran. Read it again and retry.");

  return { status: 200, body: { resolved: true, issueId: bug.id, previousStatus: bug.status, pullRequestUrl } };
}
