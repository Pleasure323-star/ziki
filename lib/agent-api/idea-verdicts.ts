import { z } from "zod";
import type { AgentLevel, IdeaOpinion, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { hasLevel, requireLevel } from "@/lib/agents/levels";
import { audit } from "@/lib/agents/audit";
import { IssueApiError } from "@/lib/agent-api/errors";
import { publish } from "@/lib/agent-api/events";
import { award } from "@/lib/points/award";
import { IDEA_CONTRIBUTION_POINTS, ideaContributionSourceKey } from "@/lib/points/rules";
import { workflowFor } from "@/lib/workflow";
import { parseIssueRef } from "@/lib/issue-ref";
import { createdSummary } from "@/lib/activity-log";
import { ENTRY_SUMMARY_MAX_CHARS, entryDescription, entrySummary, sentenceCount } from "@/lib/agent-api/entry-fields";

/**
 * Idea verdicts and conversion (#idea-verdicts, #idea-table). Each person
 * gives an idea one verdict — good, bad or neutral — with a summary of at
 * most two sentences and a full description. A verdict is all an idea takes:
 * there are no comments on ideas. Good adds its votes to the idea's score,
 * bad takes them away, neutral adds nothing. A verdict carries 1 vote; a
 * manager or merger agent may ask for up to 5. A newer verdict from the same
 * person replaces theirs.
 *
 * When the score reaches the project's `ideaThreshold`, a manager agent may
 * convert the idea, which creates an issue. The verdicts stay with the idea:
 * the issue is then confirmed on its own.
 */

export const IDEA_SUMMARY_MAX_CHARS = ENTRY_SUMMARY_MAX_CHARS;
export const MAX_IDEA_VOTES = 5;
export { sentenceCount };

const id = z.string().trim().min(1).max(191);

/** `comment` was the description's name in the first version; still accepted for agents that send it. */
const descriptionAlias = (body: unknown) =>
  body && typeof body === "object" && !Array.isArray(body) && "comment" in body && !("description" in body)
    ? (({ comment, ...rest }) => ({ ...rest, description: comment }))(body as Record<string, unknown>)
    : body;

/** The verdict body's fields. `ideaVerdictSchema` also accepts the old `comment` name. */
export const ideaVerdictFields = z
  .object({
    projectId: id.optional(),
    opinion: z.enum(["good", "bad", "neutral"]),
    votes: z.number().int().min(1).max(MAX_IDEA_VOTES).optional(),
    summary: entrySummary,
    description: entryDescription,
  })
  .strict();

export const ideaVerdictSchema = z.preprocess(descriptionAlias, ideaVerdictFields);

export type IdeaVerdictInput = z.infer<typeof ideaVerdictSchema>;

/** Who gives the verdict: an agent on its owner's behalf, or a person in the web app. */
export type VerdictGiver = { tenantId: string; userId: string; agent?: { id: string; level: AgentLevel } };

/** How many votes this giver may put on one verdict. */
export function maxVotesFor(giver: VerdictGiver): number {
  return giver.agent && hasLevel(giver.agent.level, "manager") ? MAX_IDEA_VOTES : 1;
}

/** What good, bad and neutral add to an idea's score. */
export function verdictScore(verdicts: readonly { opinion: IdeaOpinion; votes: number }[]): number {
  return verdicts.reduce((sum, v) => sum + (v.opinion === "good" ? v.votes : v.opinion === "bad" ? -v.votes : 0), 0);
}

type Tx = Prisma.TransactionClient;
type Scope = { tenantId: string; projectId: string };

type LockedIdea = {
  id: string;
  number: number;
  tenantId: string;
  projectId: string;
  status: string;
  score: number;
  reporterId: string;
  beneficiaryUserId: string;
  createdByOwnerId: string | null;
};

const IDEA_NOT_FOUND = "Idea not found in this project.";

/** `ref` is the idea's number or id. Locks the row for the rest of the transaction. */
async function lockedIdea(tx: Tx, scope: Scope, ref: string): Promise<LockedIdea> {
  const parsed = parseIssueRef(ref);
  const byNumber = parsed.kind === "number" ? parsed.number : null;
  const byId = parsed.kind === "id" ? parsed.id : null;
  const rows = await tx.$queryRaw<LockedIdea[]>`
    SELECT i."id", i."number", i."tenantId", i."projectId", i."status"::text AS "status", i."score",
           i."reporterId", i."beneficiaryUserId", a."ownerUserId" AS "createdByOwnerId"
    FROM "Idea" i
    LEFT JOIN "Agent" a ON a."id" = i."createdByAgentId"
    WHERE i."tenantId" = ${scope.tenantId}
      AND i."projectId" = ${scope.projectId}
      AND i."isDeleted" = false
      AND (i."id" = ${byId} OR i."number" = ${byNumber})
    FOR NO KEY UPDATE OF i
  `;
  if (!rows.length) throw new IssueApiError(404, IDEA_NOT_FOUND);
  return rows[0];
}

/** The idea's owner can't give it a verdict: independence is by owner. */
function ownsIdea(idea: LockedIdea, userId: string): boolean {
  return idea.reporterId === userId || idea.beneficiaryUserId === userId || idea.createdByOwnerId === userId;
}

function assertOpenIdea(idea: LockedIdea): void {
  if (idea.status === "converted") {
    const message = "This idea is an issue now. Verdicts only apply to open ideas.";
    throw new IssueApiError(409, message, { error: "idea_converted", message });
  }
  if (idea.status !== "open") throw new IssueApiError(409, "This idea is closed.", { error: "idea_closed", message: "This idea is closed." });
}

async function rescore(tx: Tx, ideaId: string): Promise<number> {
  const verdicts = await tx.ideaVerdict.findMany({ where: { ideaId }, select: { opinion: true, votes: true } });
  const score = verdictScore(verdicts);
  await tx.idea.update({ where: { id: ideaId }, data: { score } });
  return score;
}

export type GivenVerdict = {
  verdict: { id: string; opinion: IdeaOpinion; votes: number; summary: string; description: string };
  ideaScore: number;
  ideaThreshold: number;
  convertible: boolean;
  /** True when this replaced an earlier verdict from the same person. */
  replaced: boolean;
  /** Points paid for this contribution: 1 for the person's first verdict on the idea, else 0. */
  pointsAwarded: number;
};

/** Records `giver`'s verdict on an idea (by number or id), replacing any earlier one of theirs. */
export async function giveIdeaVerdict(
  giver: VerdictGiver,
  projectId: string,
  ideaRef: string,
  input: IdeaVerdictInput,
): Promise<GivenVerdict> {
  const votes = input.votes ?? 1;
  const allowed = maxVotesFor(giver);
  if (votes > allowed) {
    const message =
      allowed === 1
        ? "A verdict carries 1 vote. Only manager and merger agents may give more."
        : `A verdict carries at most ${allowed} votes.`;
    throw new IssueApiError(422, message, { error: "too_many_votes", message, maxVotes: allowed });
  }
  const { ideaThreshold } = await workflowFor(projectId);

  return prisma.$transaction(async (tx) => {
    const idea = await lockedIdea(tx, { tenantId: giver.tenantId, projectId }, ideaRef);
    assertOpenIdea(idea);
    if (ownsIdea(idea, giver.userId)) {
      throw new IssueApiError(403, "You can't give a verdict on your own idea.", { error: "own_idea", message: "You can't give a verdict on your own idea." });
    }
    const ideaId = idea.id;
    const existing = await tx.ideaVerdict.findUnique({
      where: { ideaId_onBehalfOfUserId: { ideaId, onBehalfOfUserId: giver.userId } },
      select: { id: true },
    });
    const data = {
      agentId: giver.agent?.id ?? null,
      opinion: input.opinion,
      votes,
      summary: input.summary,
      description: input.description,
    };
    const verdict = await tx.ideaVerdict.upsert({
      where: { ideaId_onBehalfOfUserId: { ideaId, onBehalfOfUserId: giver.userId } },
      create: { ideaId, onBehalfOfUserId: giver.userId, ...data },
      update: data,
      select: { id: true, opinion: true, votes: true, summary: true, description: true },
    });
    const ideaScore = await rescore(tx, ideaId);

    // The first verdict on each idea earns the person a point; the key makes a replacement free.
    const paid = await award(tx, {
      tenantId: giver.tenantId,
      userId: giver.userId,
      bugId: null,
      ideaId,
      role: "idea",
      points: IDEA_CONTRIBUTION_POINTS,
      sourceKey: ideaContributionSourceKey(ideaId, giver.userId),
    });

    const convertible = ideaScore >= ideaThreshold;
    await publish(tx, {
      tenantId: giver.tenantId,
      type: "idea.verdict",
      actorAgentId: giver.agent?.id ?? null,
      projectId,
      payload: {
        ideaId,
        ideaNumber: idea.number,
        projectId,
        userId: giver.userId,
        opinion: input.opinion,
        votes,
        ideaScore,
        ideaThreshold,
        convertible,
        replaced: Boolean(existing),
      },
    });

    return { verdict, ideaScore, ideaThreshold, convertible, replaced: Boolean(existing), pointsAwarded: paid ? IDEA_CONTRIBUTION_POINTS : 0 };
  });
}

/** Every verdict on an idea (by number or id), newest first, with the score and threshold. */
export async function listIdeaVerdicts(scope: Scope, ideaRef: string) {
  const parsed = parseIssueRef(ideaRef);
  const idea = await prisma.idea.findFirst({
    where: { ...scope, isDeleted: false, ...(parsed.kind === "number" ? { number: parsed.number } : { id: parsed.id }) },
    select: { id: true, number: true, score: true, status: true },
  });
  if (!idea) throw new IssueApiError(404, IDEA_NOT_FOUND);
  const [{ ideaThreshold }, verdicts] = await Promise.all([
    workflowFor(scope.projectId),
    prisma.ideaVerdict.findMany({
      where: { ideaId: idea.id },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        opinion: true,
        votes: true,
        summary: true,
        description: true,
        onBehalfOfUserId: true,
        agentId: true,
        createdAt: true,
        updatedAt: true,
        onBehalfOf: { select: { name: true } },
        agent: { select: { name: true } },
      },
    }),
  ]);
  const counts = { good: 0, bad: 0, neutral: 0 };
  for (const verdict of verdicts) counts[verdict.opinion] += verdict.votes;
  return {
    ideaId: idea.id,
    ideaNumber: idea.number,
    status: idea.status,
    ideaScore: idea.score,
    ideaThreshold,
    convertible: idea.status === "open" && idea.score >= ideaThreshold,
    votes: counts,
    verdicts: verdicts.map(({ onBehalfOf, agent, ...verdict }) => ({ ...verdict, by: onBehalfOf.name, agentName: agent?.name ?? null })),
  };
}

/**
 * A manager agent converts an idea whose score reached the threshold, its
 * owner's own ideas included: the verdicts already came from other people.
 * Converting creates the issue from the idea's report and files; the issue
 * then needs confirming.
 */
export async function convertIdea(agent: AgentContext, projectId: string, ideaRef: string) {
  requireLevel(agent, "manager");
  const { ideaThreshold } = await workflowFor(projectId);
  const converted = await prisma.$transaction(async (tx) => {
    const locked = await lockedIdea(tx, { tenantId: agent.tenantId, projectId }, ideaRef);
    assertOpenIdea(locked);
    if (locked.score < ideaThreshold) {
      const message = `This idea has a score of ${locked.score}; it needs ${ideaThreshold} before it can be converted.`;
      throw new IssueApiError(409, message, { error: "below_threshold", message, ideaScore: locked.score, ideaThreshold });
    }
    const idea = await tx.idea.findUniqueOrThrow({
      where: { id: locked.id },
      select: {
        title: true, description: true, typeId: true, categoryId: true, areaId: true, proofLinks: true,
        reporterId: true, beneficiaryUserId: true, createdByAgentId: true,
      },
    });
    const at = new Date();
    const issue = await tx.bug.create({
      data: {
        tenantId: agent.tenantId,
        projectId,
        title: idea.title,
        description: idea.description,
        typeId: idea.typeId,
        categoryId: idea.categoryId,
        areaId: idea.areaId,
        proofLinks: idea.proofLinks,
        reporterId: idea.reporterId,
        beneficiaryUserId: idea.beneficiaryUserId,
        createdByAgentId: idea.createdByAgentId,
        status: "requires_confirmation",
        watches: { create: { userId: idea.reporterId } },
        activities: {
          create: { actorId: idea.reporterId, type: "created", summary: createdSummary(idea.title), metadata: { fromIdea: locked.number } },
        },
      },
      select: { id: true, number: true },
    });
    // The report's files come with it; they stay readable from the idea too.
    await tx.attachment.updateMany({ where: { ideaId: locked.id }, data: { bugId: issue.id } });
    await tx.idea.update({
      where: { id: locked.id },
      data: { status: "converted", convertedAt: at, convertedByAgentId: agent.agentId, issueId: issue.id },
    });
    await publish(tx, {
      tenantId: agent.tenantId,
      type: "issue.converted",
      actorAgentId: agent.agentId,
      bugId: issue.id,
      payload: {
        ideaId: locked.id,
        ideaNumber: locked.number,
        issueId: issue.id,
        issueNumber: issue.number,
        projectId,
        ideaScore: locked.score,
        ideaThreshold,
      },
    });
    return {
      ideaId: locked.id,
      ideaNumber: locked.number,
      issueId: issue.id,
      issueNumber: issue.number,
      convertedAt: at.toISOString(),
      ideaScore: locked.score,
      ideaThreshold,
    };
  });
  await audit(
    agent,
    "idea.converted",
    `idea:${converted.ideaId}`,
    { issueId: converted.issueId, ideaScore: converted.ideaScore, ideaThreshold: converted.ideaThreshold },
    { bugId: converted.issueId },
  );
  return converted;
}
