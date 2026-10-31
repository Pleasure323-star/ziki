import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { IssueApiError } from "@/lib/agent-api/errors";
import { assertKeyProject, type AgentContext } from "@/lib/agents/require-agent";
import { audit } from "@/lib/agents/audit";
import { isOrganizationAdmin } from "@/lib/organization-role";
import type { SessionAppUser } from "@/lib/auth-helpers";

export const notesInput = z.object({
  body: z.string().trim().min(1).max(100_000),
  expectedVersion: z.number().int().min(0).max(2_147_483_646),
  reason: z.string().trim().min(1).max(500),
}).strict();
export const noteCommentInput = z.object({ body: z.string().trim().min(1).max(10_000) }).strict();
export const restoreNotesInput = z.object({ expectedVersion: z.number().int().min(1).max(2_147_483_646), reason: z.string().trim().min(1).max(500) }).strict();
export type NotesActor = {
  userId: string; name: string; tenantId: string; projectId: string; canEdit: boolean;
  agent?: AgentContext;
};

/** A project id never grants access. Recheck membership, archives and key scope. */
export async function agentNotesActor(agent: AgentContext, projectId: string): Promise<NotesActor> {
  assertKeyProject(agent, projectId);
  const project = await prisma.project.findFirst({
    where: { id: projectId, tenantId: agent.tenantId, archivedAt: null, tenant: { archivedAt: null } },
    select: { id: true },
  });
  const membership = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId: agent.tenantId, userId: agent.ownerId } }, select: { role: true },
  });
  if (!project || !membership) throw new IssueApiError(404, "Project not found.");
  return {
    userId: agent.ownerId, name: agent.name, tenantId: agent.tenantId, projectId, agent,
    // Existing organization authority and trusted admin merger grant; no new role.
    canEdit: isOrganizationAdmin(membership.role, agent.ownerRole) || agent.level === "merger",
  };
}

export async function humanNotesActor(user: SessionAppUser, tenantId: string, projectId: string): Promise<NotesActor> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, tenantId, archivedAt: null, tenant: { archivedAt: null } }, select: { id: true },
  });
  const membership = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId, userId: user.id } }, select: { role: true },
  });
  if (!project || !membership) throw new IssueApiError(404, "Project not found.");
  return { userId: user.id, name: user.name || "Workspace member", tenantId, projectId,
    canEdit: isOrganizationAdmin(membership.role, user.role) };
}

export function requireNotesEditor(actor: NotesActor) {
  if (!actor.canEdit) throw new IssueApiError(403, "Only workspace owners, admins and authorized admin agents can edit official notes.");
}

export async function readProjectNotes(actor: NotesActor) {
  const notes = await prisma.projectNotes.findUnique({ where: { projectId: actor.projectId } });
  return { notes, version: notes?.version ?? 0, canEdit: actor.canEdit };
}

async function notesAudit(db: Prisma.TransactionClient, actor: NotesActor, action: string, target: string, payload: Prisma.InputJsonValue) {
  if (actor.agent) await audit(actor.agent, action, target, payload, { db });
}

/** Conditional version update and immutable history commit together. */
export async function saveProjectNotes(actor: NotesActor, input: unknown) {
  requireNotesEditor(actor);
  const data = notesInput.parse(input);
  const editor = { editorUserId: actor.userId, editorAgentId: actor.agent?.agentId ?? null, editorName: actor.name };
  try {
    return await prisma.$transaction(async (db) => {
      const version = data.expectedVersion + 1;
      if (data.expectedVersion === 0) {
        await db.projectNotes.create({ data: { projectId: actor.projectId, body: data.body, version, ...editor } });
      } else {
        const updated = await db.projectNotes.updateMany({
          where: { projectId: actor.projectId, version: data.expectedVersion },
          data: { body: data.body, version, ...editor },
        });
        if (updated.count !== 1) throw new IssueApiError(409, "Notes changed. Reload the latest version before saving your draft.");
      }
      const revision = await db.projectNoteRevision.create({ data: {
        projectId: actor.projectId, body: data.body, version, reason: data.reason, ...editor,
      } });
      await notesAudit(db, actor, "notes.saved", actor.projectId, { version, revisionId: revision.id });
      return { notes: await db.projectNotes.findUniqueOrThrow({ where: { projectId: actor.projectId } }), version };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      throw new IssueApiError(409, "Notes changed. Reload the latest version before saving your draft.");
    }
    throw error;
  }
}

const cursorSchema = z.object({ id: z.string().min(1).max(191), createdAt: z.string().datetime() }).strict();
export function notesPage(params: URLSearchParams) {
  const limit = z.coerce.number().int().min(1).max(100).safeParse(params.get("limit") ?? 20);
  if (!limit.success) throw new IssueApiError(400, "limit must be an integer from 1 to 100.");
  let cursor: z.infer<typeof cursorSchema> | undefined;
  const raw = params.get("cursor");
  if (raw !== null) {
    try {
      if (!raw || raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
      cursor = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    } catch { throw new IssueApiError(400, "Invalid notes cursor."); }
  }
  return { limit: limit.data, cursor };
}
function pageResult<T extends { id: string; createdAt: Date }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last
    ? Buffer.from(JSON.stringify({ id: last.id, createdAt: last.createdAt.toISOString() })).toString("base64url") : null };
}

export async function listNoteComments(actor: NotesActor, params: URLSearchParams) {
  const { limit, cursor } = notesPage(params);
  const rows = await prisma.projectNoteComment.findMany({
    where: { projectId: actor.projectId, ...(cursor ? { OR: [
      { createdAt: { gt: new Date(cursor.createdAt) } },
      { createdAt: new Date(cursor.createdAt), id: { gt: cursor.id } },
    ] } : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: limit + 1,
    // `upvoted` is the person's vote (#732): theirs whether they gave it in the app or through any of their agents.
    include: { _count: { select: { votes: true } }, votes: { where: { userId: actor.userId }, select: { userId: true } } },
  });
  const result = pageResult(rows, limit);
  return { ...result, items: result.items.map(({ _count, votes, ...comment }) => ({ ...comment, upvotes: _count.votes, upvoted: votes.length > 0 })) };
}

/**
 * Adds a note comment (#732): any member of the project's workspace, in the
 * app or through an agent. Comments are contributions; they never change the
 * official notes, which only editors save.
 */
export async function addNoteComment(actor: NotesActor, input: unknown) {
  const data = noteCommentInput.parse(input);
  const agentId = actor.agent?.agentId ?? null;
  return prisma.$transaction(async (db) => {
    const comment = await db.projectNoteComment.create({ data: { projectId: actor.projectId, agentId,
      ownerId: actor.userId, authorName: actor.name, body: data.body } });
    await notesAudit(db, actor, "notes.commented", comment.id, { projectId: actor.projectId });
    return { comment };
  });
}

/**
 * Upvotes a note comment, or takes the upvote back (#732). One vote per person:
 * a member in the app and each of their agents share it, so repeating it, or
 * giving it through another agent, changes nothing.
 */
export async function voteNoteComment(actor: NotesActor, commentId: string, upvote: boolean) {
  const userId = actor.userId;
  const agentId = actor.agent?.agentId ?? null;
  return prisma.$transaction(async (db) => {
    const comment = await db.projectNoteComment.findFirst({ where: { id: commentId, projectId: actor.projectId }, select: { id: true } });
    if (!comment) throw new IssueApiError(404, "Comment not found.");
    if (upvote) {
      // Database conflict handling makes concurrent PUT requests idempotent.
      await db.projectNoteCommentVote.createMany({ data: [{ commentId, userId, agentId }], skipDuplicates: true });
    } else await db.projectNoteCommentVote.deleteMany({ where: { commentId, userId } });
    await notesAudit(db, actor, upvote ? "notes.comment_upvoted" : "notes.comment_unvoted", commentId, { projectId: actor.projectId });
    return { upvoted: upvote, upvotes: await db.projectNoteCommentVote.count({ where: { commentId } }) };
  });
}

export async function listNoteRevisions(actor: NotesActor, params: URLSearchParams) {
  const { limit, cursor } = notesPage(params);
  const rows = await prisma.projectNoteRevision.findMany({
    where: { projectId: actor.projectId, ...(cursor ? { OR: [
      { createdAt: { lt: new Date(cursor.createdAt) } },
      { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
    ] } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
  });
  return pageResult(rows, limit);
}

export async function restoreProjectNotes(actor: NotesActor, revisionId: string, input: unknown) {
  requireNotesEditor(actor);
  const data = restoreNotesInput.parse(input);
  const revision = await prisma.projectNoteRevision.findFirst({ where: { id: revisionId, projectId: actor.projectId } });
  if (!revision) throw new IssueApiError(404, "Revision not found.");
  return saveProjectNotes(actor, { ...data, body: revision.body, reason: `Restore v${revision.version}: ${data.reason}`.slice(0, 500) });
}
