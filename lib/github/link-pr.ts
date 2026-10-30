import type { PrismaClient, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { publish } from "@/lib/agent-api/events";
import { createReviewOffers } from "@/lib/agent-api/review-offer";
import { audit } from "@/lib/agents/audit";

/**
 * Record a pull request link on an issue (#452 / #474): set the URL and head
 * SHA, write the activity entry, publish `issue.pr_linked`, audit it when an
 * agent did it, and offer the fix to reviewers. Shared by the agent-facing
 * `POST /api/v1/issues/{id}/github` route and the GitHub webhook, which
 * auto-links a pull request that names the issue.
 *
 * Callers decide whether linking is allowed (claim held, repo matches,
 * acceptance binding); this only performs the write.
 */
export async function linkPullRequest(params: {
  bugId: string;
  tenantId: string;
  projectId: string;
  pullRequestUrl: string;
  pullRequestHeadSha: string | null;
  /** The claiming agent, or null when GitHub itself triggered the link. */
  actorAgentId: string | null;
  /** The person shown on the activity entry. */
  actorUserId: string;
  /** Marks how the link happened, e.g. `github_pull_request_opened`. */
  via?: string;
  screenshots?: string[];
  testResults?: string | Record<string, unknown>;
  db?: PrismaClient;
}): Promise<void> {
  const db = params.db ?? prisma;
  const { bugId, tenantId, projectId, pullRequestUrl, pullRequestHeadSha, screenshots, testResults } = params;

  await db.$transaction(async (tx) => {
    await tx.bug.update({
      where: { id: bugId },
      data: {
        pullRequestUrl,
        pullRequestHeadSha,
        // A newly linked pull request is tested from the start: In progress.
        status: "in_progress",
        ...(screenshots?.length ? { proofLinks: { push: screenshots } } : {}),
      },
    });

    const summaryEvidence = [
      screenshots?.length ? `${screenshots.length} screenshot(s)` : null,
      testResults ? "test results" : null,
    ].filter(Boolean).join(" and ");

    const meta: Prisma.InputJsonObject = {
      field: "pullRequestUrl",
      pullRequestUrl,
      ...(screenshots ? { screenshots } : {}),
      ...(testResults ? { testResults: testResults as Prisma.InputJsonValue } : {}),
      ...(params.via ? { via: params.via } : {}),
    };

    await tx.bugActivity.create({
      data: {
        bugId,
        actorId: params.actorUserId,
        type: "edited",
        summary: `linked PR ${pullRequestUrl}${summaryEvidence ? ` with ${summaryEvidence}` : ""}`,
        metadata: meta,
      },
    });

    // #539: verdicts recorded while an older build accepted them without a
    // linked pull request have an empty attribution and can never satisfy the
    // merge gate. Before acceptance only one pull request can stand on an
    // issue, so an orphan verdict could only have meant this one — point it
    // at the link instead of leaving it permanently uncounted. Verdicts that
    // already name a pull request are untouched.
    await tx.testVerdict.updateMany({
      where: { bugId, OR: [{ pullRequestUrl: null }, { pullRequestUrl: "" }] },
      data: { pullRequestUrl },
    });

    const eventPayload: Prisma.InputJsonObject = {
      issueId: bugId,
      projectId,
      pullRequestUrl,
      agentId: params.actorAgentId,
      ...(screenshots ? { screenshots } : {}),
      ...(testResults ? { testResults: testResults as Prisma.InputJsonValue } : {}),
    };

    await publish(tx, {
      tenantId,
      type: "issue.pr_linked",
      payload: eventPayload,
      actorAgentId: params.actorAgentId,
      bugId,
    });

    if (params.actorAgentId) {
      const auditPayload: Prisma.InputJsonObject = {
        pullRequestUrl,
        pullRequestHeadSha,
        ...(screenshots ? { screenshots } : {}),
        ...(testResults ? { testResults: testResults as Prisma.InputJsonValue } : {}),
      };
      await audit(
        { agentId: params.actorAgentId, tenantId },
        "github.linked",
        `bug:${bugId}`,
        auditPayload,
        { db: tx, bugId },
      );
    }
  });

  await createReviewOffers(
    db,
    { agentId: params.actorAgentId ?? undefined, tenantId },
    bugId,
    { pullRequestUrl, headSha: pullRequestHeadSha },
  ).catch(() => null);
}
