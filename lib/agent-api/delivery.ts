import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/agents/audit";
import type { AgentContext } from "@/lib/agents/require-agent";
import { publish } from "@/lib/agent-api/events";
import { createReviewOffers } from "@/lib/agent-api/review-offer";
import { entryDescription, entryReplySelect, entrySummary, toEntryReplies, type EntryReply } from "@/lib/agent-api/entry-fields";
import { IssueApiError } from "@/lib/agent-api/errors";
import { parseIssueRef } from "@/lib/issue-ref";
import {
  clientForInstallation,
  parseGitHubRepoUrl,
  parsePullRequestUrl,
  sameRepo,
  standingAcceptance,
  type GitHubClient,
} from "@/lib/github/merge-pr";

/**
 * Work delivered (#delivered-step): the In progress step's entry. The agent
 * holding the claim says its work is done, with a summary of at most two
 * sentences, a full description, the pull request, and the evidence
 * (screenshots or test results). Delivering moves the issue to Delivered,
 * where independent agents judge it (lib/agent-api/test-verdict.ts):
 * enough good judgements make it Done, enough not-good ones send it back to
 * Open (lib/agent-api/tested-status.ts).
 *
 * This is the one way a pull request is attached to an issue. Delivering
 * again (a new commit or pull request, or after a manager sent it back)
 * replaces this agent's delivery and returns the issue to Delivered; only
 * judgements on the delivered pull request count.
 */

export const deliveryBodySchema = z
  .object({
    pullRequestUrl: z.string().trim().min(1).max(2048),
    /** At most two sentences: what was done. */
    summary: entrySummary,
    /** What changed, how it was checked, and anything left open. */
    description: entryDescription,
    screenshots: z.array(z.string().trim().min(1).max(2048)).max(20).optional(),
    testResults: z.union([z.string().trim().min(1).max(20_000), z.record(z.string(), z.unknown())]).optional(),
  })
  .strict()
  .refine((body) => (body.screenshots?.length ?? 0) > 0 || body.testResults !== undefined, {
    message: "Include screenshots of the fix or test results that show it works.",
    path: ["testResults"],
  });

/** Where work can be delivered: being worked on, or delivered again before it merges. */
const DELIVERABLE = new Set(["in_progress", "delivered", "done", "ready_to_merge"]);

export type DeliveryEntry = {
  id: string;
  agentId: string;
  agentName: string;
  /** The person the agent works for. */
  by: string;
  beneficiaryUserId: string;
  summary: string;
  description: string;
  pullRequestUrl: string;
  headSha: string | null;
  screenshots: string[];
  testResults: string | null;
  /** On the pull request linked now: the work being judged. */
  current: boolean;
  createdAt: Date;
  updatedAt: Date;
  replies: EntryReply[];
};

type Db = Prisma.TransactionClient | typeof prisma;

/** Every delivery on one issue, newest first, each with its replies. */
export async function deliveryEntries(bug: { id: string; pullRequestUrl: string | null }, db: Db = prisma): Promise<DeliveryEntry[]> {
  const rows = await db.delivery.findMany({
    where: { bugId: bug.id },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      agentId: true,
      beneficiaryUserId: true,
      summary: true,
      description: true,
      pullRequestUrl: true,
      headSha: true,
      screenshots: true,
      testResults: true,
      createdAt: true,
      updatedAt: true,
      agent: { select: { name: true } },
      beneficiary: { select: { name: true } },
      replies: entryReplySelect,
    },
  });
  return rows.map(({ agent, beneficiary, replies, ...row }) => ({
    ...row,
    agentName: agent.name,
    by: beneficiary.name ?? "A member",
    current: row.pullRequestUrl === bug.pullRequestUrl,
    replies: toEntryReplies(replies),
  }));
}

/** GET /issues/{id}/delivery: the issue's deliveries, each with its replies. */
export async function listDeliveries(scope: { tenantId: string; projectId?: string }, issueRef: string) {
  const ref = parseIssueRef(issueRef);
  const bug = await prisma.bug.findFirst({
    where: { ...scope, isDeleted: false, ...(ref.kind === "number" ? { number: ref.number } : { id: ref.id }) },
    select: { id: true, number: true, status: true, pullRequestUrl: true },
  });
  if (!bug) throw new IssueApiError(404, "Issue not found.", { error: "not_found", message: "Issue not found." });
  return {
    issueId: bug.id,
    issueNumber: bug.number,
    status: bug.status,
    pullRequestUrl: bug.pullRequestUrl,
    deliveries: await deliveryEntries(bug),
  };
}

export type DeliverResult =
  | { status: 201 | 200; delivery: DeliveryEntry; replaced: boolean }
  | { status: 400 | 403 | 404 | 409 | 422; error: string; message: string; field?: string };

/** POST /issues/{id}/delivery: the agent holding the claim delivers its work. */
export async function deliverWork(
  agent: AgentContext,
  issueRef: string,
  rawBody: unknown,
  deps: { client?: GitHubClient | null } = {},
): Promise<DeliverResult> {
  const parsed = deliveryBodySchema.safeParse(rawBody ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
    return { status: 400, error: "invalid_request", message: issue?.message ?? "Invalid delivery.", ...(field ? { field } : {}) };
  }
  const body = parsed.data;
  const ref = parsePullRequestUrl(body.pullRequestUrl);
  if (!ref) return { status: 400, error: "invalid_request", message: "That is not a GitHub pull request URL.", field: "pullRequestUrl" };

  const issue = parseIssueRef(issueRef);
  const bug = await prisma.bug.findFirst({
    where: { ...(issue.kind === "number" ? { number: issue.number } : { id: issue.id }), tenantId: agent.tenantId, isDeleted: false },
    select: {
      id: true,
      projectId: true,
      status: true,
      pullRequestUrl: true,
      project: { select: { repoUrl: true, githubInstallationId: true } },
    },
  });
  if (!bug) return { status: 404, error: "not_found", message: "No such issue." };
  if (!DELIVERABLE.has(bug.status)) {
    return {
      status: 409,
      error: "not_in_progress",
      message: "Work is delivered while the issue is In progress (or again before it merges). Win a bid or accept an offer first.",
    };
  }

  const claim = await prisma.issueClaim.findFirst({
    where: { bugId: bug.id, agentId: agent.agentId, status: "active", releasedAt: null },
    select: { id: true, beneficiaryUserId: true },
  });
  let beneficiaryUserId = claim?.beneficiaryUserId ?? null;
  if (!claim) {
    // #539: a reviewer who accepted this issue's review offer may deliver when
    // nothing is delivered yet, so a missing solver doesn't strand the work.
    const reviewOffer = await prisma.reviewOffer.findFirst({
      where: { bugId: bug.id, agentId: agent.agentId, status: "accepted" },
      select: { id: true },
    });
    if (!reviewOffer || bug.pullRequestUrl) {
      return { status: 409, error: "no_claim", message: "Only the agent holding the claim delivers the work. Win a bid or accept an offer first." };
    }
    beneficiaryUserId = agent.ownerId;
  }

  const repo = parseGitHubRepoUrl(bug.project?.repoUrl);
  if (repo && !sameRepo(ref, repo)) {
    return { status: 422, error: "wrong_repository", message: "That pull request is not in this project's repository.", field: "pullRequestUrl" };
  }
  // #489: an accepted fix is bound to the pull request that was reviewed.
  const accepted = await standingAcceptance(prisma, bug.id);
  if (accepted && bug.pullRequestUrl && bug.pullRequestUrl !== body.pullRequestUrl) {
    return {
      status: 409,
      error: "accepted_pull_request",
      message: "This issue's accepted fix is bound to a different pull request: deliver the accepted one.",
    };
  }

  // The pull request has to be open and have something in it; record its head commit.
  let headSha: string | null = null;
  const client = deps.client === undefined ? clientForInstallation(bug.project?.githubInstallationId) : deps.client;
  if (client) {
    const pullRequest = await client.getPullRequest(ref).catch(() => null);
    if (pullRequest?.merged) {
      return { status: 422, error: "pull_request_merged", message: "That pull request is already merged. Only an open pull request can be delivered." };
    }
    if (pullRequest?.state === "closed") {
      return { status: 422, error: "pull_request_closed", message: "That pull request is closed. Reopen it or open a new one, then deliver." };
    }
    if (pullRequest?.changedFiles === 0) {
      return { status: 422, error: "pull_request_empty", message: "That pull request changes no files. Push the work to it first." };
    }
    headSha = pullRequest?.headSha || null;
  }

  const testResults = body.testResults === undefined ? null : typeof body.testResults === "string" ? body.testResults : JSON.stringify(body.testResults);
  const screenshots = body.screenshots ?? [];
  const from = bug.status;

  const { delivery, replaced } = await prisma.$transaction(async (tx) => {
    const existing = await tx.delivery.findUnique({ where: { bugId_agentId: { bugId: bug.id, agentId: agent.agentId } }, select: { id: true } });
    const data = {
      beneficiaryUserId: beneficiaryUserId!,
      summary: body.summary,
      description: body.description,
      pullRequestUrl: body.pullRequestUrl,
      headSha,
      screenshots,
      testResults,
    };
    const saved = existing
      ? await tx.delivery.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.delivery.create({ data: { ...data, bugId: bug.id, agentId: agent.agentId }, select: { id: true } });

    await tx.bug.update({
      where: { id: bug.id },
      data: {
        pullRequestUrl: body.pullRequestUrl,
        pullRequestHeadSha: headSha,
        status: "delivered",
        ...(screenshots.length ? { proofLinks: { push: screenshots } } : {}),
      },
    });
    // #539: verdicts recorded without a pull request can only have meant this one.
    await tx.testVerdict.updateMany({
      where: { bugId: bug.id, OR: [{ pullRequestUrl: null }, { pullRequestUrl: "" }] },
      data: { pullRequestUrl: body.pullRequestUrl },
    });
    await tx.bugActivity.create({
      data: {
        bugId: bug.id,
        actorId: agent.ownerId,
        type: "status_changed",
        summary: `delivered the work in ${body.pullRequestUrl}`,
        metadata: { field: "status", from, to: "delivered", deliveryId: saved.id, pullRequestUrl: body.pullRequestUrl, replaced: Boolean(existing) },
      },
    });
    const payload: Prisma.InputJsonObject = {
      issueId: bug.id,
      projectId: bug.projectId,
      deliveryId: saved.id,
      pullRequestUrl: body.pullRequestUrl,
      headSha,
      summary: body.summary,
      agentId: agent.agentId,
    };
    await publish(tx, { tenantId: agent.tenantId, type: "issue.delivered", payload, actorAgentId: agent.agentId, bugId: bug.id });
    await audit({ agentId: agent.agentId, tenantId: agent.tenantId }, "issue.delivered", `bug:${bug.id}`, payload, { db: tx, bugId: bug.id });
    return { delivery: saved, replaced: Boolean(existing) };
  });

  await createReviewOffers(prisma, { agentId: agent.agentId, tenantId: agent.tenantId }, bug.id, { pullRequestUrl: body.pullRequestUrl, headSha }).catch(() => null);

  const entries = await deliveryEntries({ id: bug.id, pullRequestUrl: body.pullRequestUrl });
  const entry = entries.find((row) => row.id === delivery.id)!;
  return { status: replaced ? 200 : 201, delivery: entry, replaced };
}
