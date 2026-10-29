import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/agents/audit";
import {
  assertIndependentReviewer,
  reviewerCreditConflict,
  ReviewerNotIndependentError,
  type ReviewedBug,
} from "@/lib/agents/independence";
import { hasLevel } from "@/lib/agents/levels";
import type { AgentContext } from "@/lib/agents/require-agent";
import { publish } from "@/lib/agent-api/events";
import { handleTestVerdictSubmitted } from "@/lib/agent-api/review-offer";
import { parsePullRequestUrl, type GitHubClient, type PullRequest } from "@/lib/github/merge-pr";
import { combineProblems, notifyAuthor, readinessClient, readinessProblems } from "@/lib/agent-api/pr-readiness";
import { recordVerdictBlocked } from "@/lib/merge-status";
import { refreshTestedStatus } from "@/lib/agent-api/tested-status";

/**
 * Reviewer agents reporting whether a fix is good to merge (#434). A verdict
 * is one reviewer's opinion, not the decision: `merge.ts` accepts a fix only
 * once the issue is confirmed and the project's required reviewers say it is
 * good to merge.
 *
 * - Only `reviewer` and `merger` agents may file a verdict.
 * - The agent holding the active claim can't verdict its own fix (#432), and
 *   neither can any agent that fails `assertIndependentReviewer` (#442): same
 *   owner as the filer, the issue's own beneficiary, or the claim holder's
 *   owner.
 * - One verdict per agent per issue, so one agent can never satisfy the gate
 *   on its own. Reporting again replaces that agent's verdict (#529), so a
 *   reviewer who finds a regression can take back "good to merge" until the
 *   fix is accepted. The audit log keeps every change.
 * - "Good to merge" is only recorded when the pull request is ready: every check
 *   on its head commit is green, CodeRabbit has no unresolved review threads,
 *   and it doesn't conflict with its base branch (#255). Otherwise nothing is
 *   recorded, a comment lists every reason and what the author has to do, and
 *   the author is told. A "not good to merge" verdict is always recorded.
 * - A verdict needs a linked pull request and records which one it tested
 *   (#526), and the head commit it tested (#489). Linking a different PR means
 *   the old verdicts no longer count.
 */

export const TEST_VERDICT_NOTES_MAX = 2000;

export const testVerdictBodySchema = z.object({
  goodToMerge: z.boolean(),
  notes: z.string().trim().max(TEST_VERDICT_NOTES_MAX).optional(),
  /** The person the agent acts for; defaults to its owner. */
  onBehalfOfUserId: z.string().trim().min(1).max(191).optional(),
  /**
   * The head commit the reviewer tested (#489). Defaults to the SHA recorded
   * when the pull request was linked, so every verdict names its code.
   */
  headSha: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,64}$/i, "headSha must be a hexadecimal commit SHA.")
    .optional(),
});

export type TestVerdictBody = z.infer<typeof testVerdictBodySchema>;

/** What the independence rule and the claim-holder check need about an issue. */
const reviewedBugSelect = {
  id: true,
  title: true,
  tenantId: true,
  status: true,
  pullRequestUrl: true,
  pullRequestHeadSha: true,
  severity: true,
  beneficiaryUserId: true,
  assigneeId: true,
  reporterId: true,
  createdByAgentId: true,
  createdByAgent: { select: { ownerUserId: true } },
  project: { select: { githubInstallationId: true } },
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

type LoadedBug = Prisma.BugGetPayload<{ select: typeof reviewedBugSelect }>;

/** The agent holding the active claim on `bug`, if any (#432). */
function activeClaimAgent(bug: LoadedBug): string | null {
  const claim = bug.claims.find((c) => c.status === "active" && !c.releasedAt);
  return claim?.agentId ?? null;
}

type StoredVerdict = {
  id: string;
  goodToMerge: boolean;
  notes: string | null;
  onBehalfOfUserId: string;
  pullRequestUrl: string | null;
  headSha: string | null;
  changedAt: Date | null;
};

export type SubmitTestVerdictResult =
  | { status: 201; verdict: StoredVerdict }
  /** The agent had a verdict on this issue already, and it was replaced (#529). */
  | { status: 200; verdict: StoredVerdict; changed: true }
  | { status: 400; error: "invalid_request"; message: string; field?: string }
  | { status: 403; error: "insufficient_level" | "fixer_cannot_verdict" | "not_independent"; message: string }
  | { status: 404; error: "not_found"; message: string }
  | { status: 409; error: "no_pull_request" | "already_accepted" | "already_verdicted"; message: string }
  /** "Good to merge" was not recorded because the pull request isn't ready (#255). */
  | {
      status: 409;
      error: "not_ready";
      missing: "github_app" | "pull_request" | "deployment_verification" | "review_threads" | "merge_conflict";
      message: string;
    };

export type SubmitTestVerdictDeps = { client?: GitHubClient | null };

export async function submitTestVerdict(
  agent: AgentContext,
  bugId: string,
  rawBody: unknown,
  deps: SubmitTestVerdictDeps = {},
): Promise<SubmitTestVerdictResult> {
  if (!hasLevel(agent.level, "working")) {
    return {
      status: 403,
      error: "insufficient_level",
      message: "This agent can't report a test verdict.",
    };
  }

  const parsed = testVerdictBodySchema.safeParse(rawBody ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      status: 400,
      error: "invalid_request",
      message: issue?.message ?? "Invalid test verdict.",
      field: typeof issue?.path[0] === "string" ? issue.path[0] : undefined,
    };
  }
  const body = parsed.data;

  const bug = await prisma.bug.findFirst({
    where: { id: bugId, tenantId: agent.tenantId, isDeleted: false },
    select: reviewedBugSelect,
  });
  if (!bug) return { status: 404, error: "not_found", message: "No such issue in this agent's tenant." };

  // #526: "good to merge" has to be about some code.
  if (!bug.pullRequestUrl) {
    return {
      status: 409,
      error: "no_pull_request",
      message: "Link the fix's pull request (POST /api/v1/issues/{id}/github) before reporting a test verdict.",
    };
  }
  // #529: verdicts can change until the fix is accepted, not after.
  if (bug.status === "resolved" || bug.status === "closed") {
    return {
      status: 409,
      error: "already_accepted",
      message: "This fix has already been accepted, so its verdicts can't change.",
    };
  }
  const pullRequestUrl = bug.pullRequestUrl;
  // #489: the verdict records the commit it tested. An agent that inspected
  // a newer commit says so; otherwise the SHA recorded when the PR was linked.
  const headSha = body.headSha ?? bug.pullRequestHeadSha;

  if (activeClaimAgent(bug) === agent.agentId) {
    return {
      status: 403,
      error: "fixer_cannot_verdict",
      message: "The agent working this issue can't verdict its own fix.",
    };
  }
  try {
    assertIndependentReviewer({ id: agent.agentId, ownerUserId: agent.ownerId }, bug as ReviewedBug);
  } catch (error) {
    if (!(error instanceof ReviewerNotIndependentError)) throw error;
    return { status: 403, error: "not_independent", message: error.message };
  }

  const onBehalfOfUserId = body.onBehalfOfUserId ?? agent.ownerId;
  if (onBehalfOfUserId !== agent.ownerId) {
    const member = await prisma.membership.findUnique({
      where: { tenantId_userId: { tenantId: agent.tenantId, userId: onBehalfOfUserId } },
      select: { id: true },
    });
    if (!member) {
      return {
        status: 400,
        error: "invalid_request",
        message: "onBehalfOfUserId must be a member of the agent's tenant.",
        field: "onBehalfOfUserId",
      };
    }
  }
  if (reviewerCreditConflict(onBehalfOfUserId, bug as ReviewedBug)) {
    return {
      status: 403,
      error: "not_independent",
      message: "onBehalfOfUserId must be independent of the issue's reporter, solver, and claim beneficiary.",
    };
  }

  // A tester only says "good to merge" about a pull request that is ready.
  if (body.goodToMerge) {
    const block = await readyBlock(bug, deps, headSha);
    if (block) {
      const claim = bug.claims.find((c) => c.status === "active" && !c.releasedAt);
      await recordVerdictBlocked(prisma, { agent, bug, reason: block.message, todo: block.todo });
      notifyAuthor({
        bug,
        recipientId: claim?.beneficiaryUserId ?? bug.assigneeId,
        reason: block.message,
        fromAgentName: agent.name,
      });
      return { status: 409, error: "not_ready", missing: block.missing, message: block.message };
    }
  }

  const verdictSelect = {
    id: true,
    goodToMerge: true,
    notes: true,
    onBehalfOfUserId: true,
    pullRequestUrl: true,
    headSha: true,
    changedAt: true,
  } as const;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.testVerdict.findFirst({
        where: { bugId: bug.id, agentId: agent.agentId },
        orderBy: { createdAt: "asc" },
        select: verdictSelect,
      });

      if (existing) {
        // #529: replace this agent's verdict. The audit row keeps the old one.
        const verdict = await tx.testVerdict.update({
          where: { id: existing.id },
          data: {
            goodToMerge: body.goodToMerge,
            notes: body.notes || null,
            onBehalfOfUserId,
            pullRequestUrl,
            headSha,
            changedAt: new Date(),
          },
          select: verdictSelect,
        });
        await audit(
          agent,
          "issue.test_verdict_changed",
          `bug:${bug.id}`,
          {
            verdictId: verdict.id,
            from: { goodToMerge: existing.goodToMerge, pullRequestUrl: existing.pullRequestUrl },
            to: { goodToMerge: body.goodToMerge, pullRequestUrl, headSha },
            onBehalfOfUserId,
          },
          { bugId: bug.id, db: tx },
        );
        await publish(tx, {
          tenantId: bug.tenantId,
          type: "issue.test_verdict",
          payload: {
            issueId: bug.id,
            verdictId: verdict.id,
            goodToMerge: body.goodToMerge,
            onBehalfOfUserId,
            pullRequestUrl,
            headSha,
            changed: true,
            previousGoodToMerge: existing.goodToMerge,
          },
          actorAgentId: agent.agentId,
          bugId: bug.id,
        });
        await handleTestVerdictSubmitted(tx, { bugId: bug.id, agentId: agent.agentId, tenantId: bug.tenantId, pullRequestUrl }).catch(() => null);
        return { status: 200 as const, verdict, changed: true as const };
      }

      const verdict = await tx.testVerdict.create({
        data: {
          bugId: bug.id,
          agentId: agent.agentId,
          onBehalfOfUserId,
          goodToMerge: body.goodToMerge,
          notes: body.notes || null,
          pullRequestUrl,
          headSha,
        },
        select: verdictSelect,
      });

      await audit(
        agent,
        "issue.test_verdict",
        `bug:${bug.id}`,
        { verdictId: verdict.id, goodToMerge: body.goodToMerge, onBehalfOfUserId, pullRequestUrl, headSha },
        { bugId: bug.id, db: tx },
      );
      await publish(tx, {
        tenantId: bug.tenantId,
        type: "issue.test_verdict",
        payload: { issueId: bug.id, verdictId: verdict.id, goodToMerge: body.goodToMerge, onBehalfOfUserId, pullRequestUrl, headSha },
        actorAgentId: agent.agentId,
        bugId: bug.id,
      });

      await handleTestVerdictSubmitted(tx, { bugId: bug.id, agentId: agent.agentId, tenantId: bug.tenantId, pullRequestUrl }).catch(() => null);
      return { status: 201 as const, verdict };
    });
    // Ziki #713: the required independent good-to-merge verdicts make the fix
    // tested (the Done tab); a verdict taken back returns it to In progress.
    await refreshTestedStatus(prisma, bug.id, agent.ownerId);
    return result;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return {
        status: 409 as const,
        error: "already_verdicted" as const,
        message: "This agent has already reported a verdict on this issue.",
      };
    }
    throw error;
  }
}

/**
 * Why a tester can't say "good to merge" yet: GitHub can't be asked, or the
 * pull request has red checks, open CodeRabbit threads or a merge conflict.
 * Null when it is ready.
 */
async function readyBlock(
  bug: LoadedBug,
  deps: SubmitTestVerdictDeps,
  testedHeadSha: string | null | undefined,
): Promise<{
  missing: "github_app" | "pull_request" | "deployment_verification" | "review_threads" | "merge_conflict";
  message: string;
  todo: string;
} | null> {
  const client = deps.client !== undefined ? deps.client : readinessClient(bug.project?.githubInstallationId);
  if (!client) {
    return {
      missing: "github_app",
      message:
        "The GitHub App is not set up for this project, so Ziki can't check that the checks are green, CodeRabbit's threads are resolved and there is no merge conflict.",
      todo: "A tenant admin installs the Ziki GitHub App on this project's repository and sets the repository on the project. Then report again.",
    };
  }
  const ref = parsePullRequestUrl(bug.pullRequestUrl);
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
      todo: "Nothing is wrong with the fix. Report again in a few minutes.",
    };
  }
  const claim = bug.claims.find((c) => c.status === "active" && !c.releasedAt);
  return combineProblems(
    await readinessProblems(client, ref, pullRequest, testedHeadSha || pullRequest.headSha, claim?.agent.name),
  );
}
