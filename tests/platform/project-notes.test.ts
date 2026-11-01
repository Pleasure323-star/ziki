import { beforeEach, describe, expect, it, vi } from "vitest";

/** Project notes (#732): only workspace admins and admin agents edit the official notes, each save is a revision, stale saves are refused, and everyone in the project may comment and vote once. */
const db = vi.hoisted(() => ({
  project: { findFirst: vi.fn() }, membership: { findUnique: vi.fn() },
  projectNotes: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
  projectNoteRevision: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  projectNoteComment: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  projectNoteCommentVote: { createMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
  agentAuditEvent: { create: vi.fn() }, $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
import { agentNotesActor, saveProjectNotes,
  addNoteComment, voteNoteComment, restoreProjectNotes, type NotesActor } from "@/lib/project-notes";
import type { AgentContext } from "@/lib/agents/require-agent";

const agent: AgentContext = { agentId: "agent", ownerId: "owner", tenantId: "tenant", name: "Worker", level: "working", projectId: "project", keyId: "key", burst: false };
const actor: NotesActor = { projectId: "project", tenantId: "tenant", userId: "owner", name: "Worker", agent, canEdit: true };
const input = { body: "Use migrations only.", expectedVersion: 0, reason: "Initial guidance" };

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation(async (run) => run(db));
  db.project.findFirst.mockResolvedValue({ id: "project" });
  db.membership.findUnique.mockResolvedValue({ role: "member" });
  db.projectNoteRevision.create.mockResolvedValue({ id: "revision" });
  db.projectNotes.findUniqueOrThrow.mockResolvedValue({ body: input.body, version: 1 });
  db.projectNotes.updateMany.mockResolvedValue({ count: 1 });
});

describe("project notes access", () => {
  it("does not let a key read another project", async () => {
    await expect(agentNotesActor(agent, "foreign")).rejects.toMatchObject({ name: "AgentProjectError" });
    expect(db.project.findFirst).not.toHaveBeenCalled();
  });
  it("does not confer workspace authority from a site admin title", async () => {
    expect((await agentNotesActor({ ...agent, ownerRole: "admin" }, "project")).canEdit).toBe(false);
  });
});

describe("official notes and history", () => {
  it("refuses unauthorized writes before opening a transaction", async () => {
    await expect(saveProjectNotes({ ...actor, canEdit: false }, input)).rejects.toMatchObject({ status: 403 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("creates the document, immutable revision and agent audit together", async () => {
    await expect(saveProjectNotes(actor, input)).resolves.toMatchObject({ version: 1 });
    expect(db.projectNotes.create).toHaveBeenCalledWith({ data: expect.objectContaining({ projectId: "project", version: 1, editorAgentId: "agent" }) });
    expect(db.projectNoteRevision.create).toHaveBeenCalledWith({ data: expect.objectContaining({ reason: "Initial guidance", version: 1, editorUserId: "owner" }) });
    expect(db.agentAuditEvent.create).toHaveBeenCalled();
  });
  it("detects stale saves and never writes a revision for them", async () => {
    db.projectNotes.updateMany.mockResolvedValue({ count: 0 });
    await expect(saveProjectNotes(actor, { ...input, expectedVersion: 3 })).rejects.toMatchObject({ status: 409 });
    expect(db.projectNoteRevision.create).not.toHaveBeenCalled();
  });
  it.each([
    { ...input, body: " " }, { ...input, expectedVersion: -1 }, { ...input, reason: "" },
    { ...input, body: "x".repeat(100001) }, { ...input, editorAgentId: "forged" },
  ])("rejects malformed or forged official-note input", async (data) => {
    await expect(saveProjectNotes(actor, data)).rejects.toThrow();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("cannot restore a revision from another project", async () => {
    db.projectNoteRevision.findFirst.mockResolvedValue(null);
    await expect(restoreProjectNotes(actor, "foreign", { expectedVersion: 2, reason: "Restore" })).rejects.toMatchObject({ status: 404 });
    expect(db.projectNoteRevision.findFirst).toHaveBeenCalledWith({ where: { id: "foreign", projectId: "project" } });
  });
});

describe("people in the notes discussion (#732)", () => {
  const person: NotesActor = { projectId: "project", tenantId: "tenant", userId: "member", name: "Ada", canEdit: false };
  it("lets a member who can't edit the official notes add a comment, with no agent", async () => {
    db.projectNoteComment.create.mockResolvedValue({ id: "comment" });
    await addNoteComment(person, { body: "The staging URL changed." });
    expect(db.projectNoteComment.create).toHaveBeenCalledWith({ data: { projectId: "project", agentId: null, ownerId: "member", authorName: "Ada", body: "The staging URL changed." } });
    expect(db.projectNotes.updateMany).not.toHaveBeenCalled();
  });
});

describe("agent discussion", () => {
  it("keeps one idempotent vote per person and never changes official guidance (#732)", async () => {
    db.projectNoteComment.findFirst.mockResolvedValue({ id: "comment" });
    db.projectNoteCommentVote.count.mockResolvedValue(1);
    expect(await voteNoteComment(actor, "comment", true)).toEqual({ upvoted: true, upvotes: 1 });
    expect(db.projectNoteCommentVote.createMany).toHaveBeenCalledWith({ data: [{ commentId: "comment", userId: "owner", agentId: "agent" }], skipDuplicates: true });
    await voteNoteComment(actor, "comment", false);
    expect(db.projectNoteCommentVote.deleteMany).toHaveBeenCalledWith({ where: { commentId: "comment", userId: "owner" } });
    expect(db.projectNotes.updateMany).not.toHaveBeenCalled();
    expect(db.projectNoteRevision.create).not.toHaveBeenCalled();
  });
});
