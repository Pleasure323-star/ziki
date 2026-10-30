import { NextResponse, type NextRequest } from "next/server";
import { reportSummarySchema } from "@/lib/validations/report-summary";
import { z } from "zod";
import type { IdeaStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { audit } from "@/lib/agents/audit";
import { IssueApiError } from "@/lib/agent-api/errors";
import { publish } from "@/lib/agent-api/events";
import {
  createIdeaWithPolicy,
  decodeCursor,
  hashCreateRequest,
  LIMIT_RANGE_ERROR,
  pageSize,
  toPage,
  type IssueCursor,
} from "@/lib/agent-api/create-policy";
import { issueJson, issueProject } from "@/lib/agent-api/issues";
import { createBugSchema } from "@/lib/validations/issue";
import { attachmentIdsInMarkdown, linkAttachments } from "@/lib/attachment-link";
import { MAX_ATTACHMENTS_PER_ITEM } from "@/lib/attachments";
import { extractMentionedUserIds, normalizeMentions } from "@/lib/mentions";
import { boundSearchTerm, escapeSearchQuery } from "@/lib/search";
import { parseIssueRef } from "@/lib/issue-ref";
import { workflowFor } from "@/lib/workflow";

/**
 * Ideas through the agent API (#idea-table). Every report is an idea: an
 * agent files one with `POST /api/v1/ideas`, people and agents give it
 * verdicts, and a manager agent converts it to an issue once its score
 * reaches the project's `ideaThreshold` (lib/agent-api/idea-verdicts.ts).
 * Ideas are numbered apart from issues.
 */

type Scope = { tenantId: string; projectId: string };

const idSchema = z.string().trim().min(1).max(191);
const attachmentIdsSchema = z.array(idSchema).max(MAX_ATTACHMENTS_PER_ITEM).optional();

export const createIdeaSchema = createBugSchema
  .pick({ title: true, description: true, categoryId: true, areaId: true, proofLinks: true })
  .extend({
    // #494: no beneficiaryUserId. The reporter is always the agent's owner.
    projectId: idSchema.optional(),
    typeId: z.unknown().optional(),
    acknowledgeSimilar: z.unknown().optional(),
    attachmentIds: attachmentIdsSchema,
    // Up to three plain lines a person can read at a glance (#report-summary).
    summary: reportSummarySchema,
  })
  .strict();

export const IDEA_STATUSES = ["open", "converted", "rejected"] as const satisfies readonly IdeaStatus[];

export const ideaSelect = {
  id: true,
  number: true,
  title: true,
  summary: true,
  description: true,
  status: true,
  score: true,
  typeId: true,
  categoryId: true,
  areaId: true,
  proofLinks: true,
  projectId: true,
  reporterId: true,
  beneficiaryUserId: true,
  createdByAgentId: true,
  convertedAt: true,
  createdAt: true,
  updatedAt: true,
  area: { select: { id: true, name: true, slug: true } },
  issue: { select: { id: true, number: true } },
} satisfies Prisma.IdeaSelect;

type IdeaRow = Prisma.IdeaGetPayload<{ select: typeof ideaSelect }>;

/** The idea as the API shows it: the issue it became, and whether it can be converted now. */
export function ideaJson(idea: IdeaRow, ideaThreshold: number) {
  const { issue, ...rest } = idea;
  return {
    ...rest,
    issueId: issue?.id ?? null,
    issueNumber: issue?.number ?? null,
    ideaThreshold,
    convertible: idea.status === "open" && idea.score >= ideaThreshold,
  };
}

/** `?status=`, `?convertible=`, `?q=` and the shared cursor, newest first. */
export async function listAgentIdeas(scope: Scope, params: URLSearchParams) {
  const rawStatus = params.get("status");
  if (rawStatus && !(IDEA_STATUSES as readonly string[]).includes(rawStatus)) {
    throw new IssueApiError(400, `status must be one of ${IDEA_STATUSES.join(", ")}.`);
  }
  const convertibleRaw = params.get("convertible");
  if (convertibleRaw !== null && convertibleRaw !== "true" && convertibleRaw !== "false") {
    throw new IssueApiError(400, "convertible must be true or false.");
  }
  const cursorRaw = params.get("cursor");
  const cursor = decodeCursor(cursorRaw);
  if (cursorRaw !== null && !cursor) throw new IssueApiError(400, "Invalid cursor.");
  const limit = pageSize(params.get("limit"));
  if (limit === null) throw new IssueApiError(400, LIMIT_RANGE_ERROR);
  const { ideaThreshold } = await workflowFor(scope.projectId);
  const q = params.get("q")?.trim();
  const term = q ? escapeSearchQuery(boundSearchTerm(q)) : null;
  const where: Prisma.IdeaWhereInput = {
    ...scope,
    isDeleted: false,
    ...(rawStatus ? { status: rawStatus as IdeaStatus } : {}),
    ...(convertibleRaw === "true" ? { status: "open", score: { gte: ideaThreshold } } : {}),
    ...(convertibleRaw === "false" ? { NOT: { status: "open", score: { gte: ideaThreshold } } } : {}),
    ...(term
      ? { AND: [{ OR: [{ title: { contains: term, mode: "insensitive" } }, { description: { contains: term, mode: "insensitive" } }] }] }
      : {}),
    ...(cursor ? ideaCursorWhere(cursor) : {}),
  };
  const rows = await prisma.idea.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: ideaSelect,
  });
  const page = toPage(rows, limit);
  return { ...page, items: page.items.map((row) => ideaJson(row, ideaThreshold)) };
}

function ideaCursorWhere(cursor: IssueCursor): Prisma.IdeaWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

/** `ref` is the idea's number (`12`) or its id. */
export async function findIdea(scope: Scope, ref: string) {
  const parsed = parseIssueRef(ref);
  return prisma.idea.findFirst({
    where: { ...scope, isDeleted: false, ...(parsed.kind === "number" ? { number: parsed.number } : { id: parsed.id }) },
    select: { id: true },
  });
}

export async function readAgentIdea(scope: Scope, ref: string) {
  const found = await findIdea(scope, ref);
  if (!found) throw new IssueApiError(404, "Idea not found.");
  const [idea, { ideaThreshold }] = await Promise.all([
    prisma.idea.findUniqueOrThrow({
      where: { id: found.id },
      select: {
        ...ideaSelect,
        attachments: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, filename: true, contentType: true, size: true, createdAt: true },
        },
      },
    }),
    workflowFor(scope.projectId),
  ]);
  return ideaJson(idea, ideaThreshold) as ReturnType<typeof ideaJson> & { attachments: typeof idea.attachments };
}

async function normalizeTenantMentions(db: Prisma.TransactionClient, tenantId: string, body: string) {
  const ids = extractMentionedUserIds(body);
  const users = ids.length
    ? await db.user.findMany({ where: { id: { in: ids }, memberships: { some: { tenantId } } }, select: { id: true, name: true } })
    : [];
  return normalizeMentions(body, new Map(users.map((user) => [user.id, user.name])));
}

/** Files the agent's owner uploaded, by id (all must link) or linked from the text (best effort). */
async function linkAgentIdeaAttachments(
  tx: Prisma.TransactionClient,
  agent: AgentContext,
  input: { requested?: string[]; text: string; ideaId: string },
): Promise<void> {
  const requested = [...new Set(input.requested ?? [])];
  if (requested.length > 0) {
    const linked = await linkAttachments(tx, { ids: requested, uploaderId: agent.ownerId, ideaId: input.ideaId });
    if (linked !== requested.length) {
      throw new IssueApiError(422, "One or more attachmentIds weren't found, belong to someone else, or are already attached.");
    }
  }
  const referenced = attachmentIdsInMarkdown(input.text).filter((id) => !requested.includes(id));
  if (referenced.length > 0) {
    await linkAttachments(tx, { ids: referenced, uploaderId: agent.ownerId, ideaId: input.ideaId });
  }
}

/** `POST /api/v1/ideas`: an agent files a report, which is always an idea. */
export async function createAgentIdea(agent: AgentContext, request: NextRequest) {
  const input = createIdeaSchema.parse(await issueJson(request));
  const scope = await issueProject(agent, request.nextUrl.searchParams, input.projectId);
  const beneficiaryUserId = agent.ownerId;
  const requestHash = hashCreateRequest({
    projectId: scope.projectId,
    beneficiaryUserId,
    title: input.title,
    summary: input.summary,
    description: input.description,
    categoryId: input.categoryId || null,
    proofLinks: input.proofLinks,
    typeId: input.typeId ?? null,
    acknowledgeSimilar: input.acknowledgeSimilar ?? null,
    ...(input.attachmentIds?.length ? { attachmentIds: [...new Set(input.attachmentIds)].sort() } : {}),
    ...(input.areaId ? { areaId: input.areaId } : {}),
  });
  const result = await createIdeaWithPolicy({
    agent,
    projectId: scope.projectId,
    idempotencyKey: request.headers.get("Idempotency-Key"),
    requestHash,
    title: input.title,
    typeId: input.typeId,
    acknowledgeSimilar: input.acknowledgeSimilar,
    insert: async (tx, policy) => {
      const member = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId: scope.tenantId, userId: beneficiaryUserId } },
        select: { userId: true },
      });
      if (!member) throw new IssueApiError(422, "The beneficiary must be a member of the tenant.");
      const categoryId = input.categoryId || null;
      if (categoryId) {
        const category = await tx.category.findFirst({ where: { id: categoryId, tenantId: scope.tenantId, isActive: true }, select: { id: true } });
        if (!category) throw new IssueApiError(422, "Platform not found or inactive.");
      }
      const areaId = input.areaId || null;
      if (areaId) {
        const area = await tx.projectArea.findFirst({ where: { id: areaId, projectId: scope.projectId }, select: { id: true } });
        if (!area) throw new IssueApiError(422, "Area not found in this project.");
      }
      const description = await normalizeTenantMentions(tx, scope.tenantId, input.description);
      const idea = await tx.idea.create({
        data: {
          ...scope,
          typeId: policy.typeId,
          title: input.title,
          summary: input.summary,
          description,
          categoryId,
          areaId,
          proofLinks: input.proofLinks,
          reporterId: beneficiaryUserId,
          beneficiaryUserId,
          createdByAgentId: agent.agentId,
        },
        select: { id: true, number: true },
      });
      await linkAgentIdeaAttachments(tx, agent, { requested: input.attachmentIds, text: description, ideaId: idea.id });
      await audit(agent, "idea.created", `idea:${idea.id}`, { beneficiaryUserId, number: idea.number }, { db: tx });
      await publish(tx, {
        tenantId: scope.tenantId,
        type: "idea.created",
        payload: { ideaId: idea.id, ideaNumber: idea.number, projectId: scope.projectId, beneficiaryUserId },
        actorAgentId: agent.agentId,
        projectId: scope.projectId,
      });
      return idea;
    },
  });
  if (result.status !== 200 && result.status !== 201) return NextResponse.json(result, { status: result.status });
  // A reused key can refer to another project; never return an out-of-scope idea.
  const idea = await readAgentIdea(scope, result.ideaId);
  return NextResponse.json({ idea, replayed: result.replayed }, { status: result.status });
}
