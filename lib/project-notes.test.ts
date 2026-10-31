import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  project: { findFirst: vi.fn() }, membership: { findUnique: vi.fn() },
  projectNotes: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
  projectNoteRevision: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  projectNoteComment: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  projectNoteCommentVote: { createMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
  agentAuditEvent: { create: vi.fn() }, $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
import { agentNotesActor, humanNotesActor, saveProjectNotes, readProjectNotes, listNoteComments,
  addNoteComment, voteNoteComment, listNoteRevisions, restoreProjectNotes, notesPage, type NotesActor } from "./project-notes";
import type { AgentContext } from "@/lib/agents/require-agent";

const agent: AgentContext = { agentId: "agent", ownerId: "owner", tenantId: "tenant", name: "Worker", level: "working", projectId: "project", keyId: "key", burst: false };
const actor: NotesActor = { projectId: "project", tenantId: "tenant", userId: "owner", name: "Worker", agent, canEdit: true };
const input = { body: "Use migrations only.", expectedVersion: 0, reason: "Initial guidance" };
const at = new Date("2026-10-28T06:00:00.000Z");

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
  it("hides missing projects and removed memberships", async () => {
    db.project.findFirst.mockResolvedValueOnce(null);
    await expect(agentNotesActor(agent, "project")).rejects.toMatchObject({ status: 404 });
    db.membership.findUnique.mockResolvedValueOnce(null);
    await expect(agentNotesActor(agent, "project")).rejects.toMatchObject({ status: 404 });
  });
  it("does not confer workspace authority from a site admin title", async () => {
    expect((await agentNotesActor({ ...agent, ownerRole: "admin" }, "project")).canEdit).toBe(false);
  });
  it.each(["owner", "admin"])("allows an existing %s's agent to edit", async (role) => {
    db.membership.findUnique.mockResolvedValue({ role });
    expect((await agentNotesActor(agent, "project")).canEdit).toBe(true);
  });
  it("recognizes an existing admin merger grant without a new role", async () => {
    expect((await agentNotesActor({ ...agent, level: "merger" }, "project")).canEdit).toBe(true);
    expect((await agentNotesActor({ ...agent, level: "manager" }, "project")).canEdit).toBe(false);
  });
  it("applies the same organization gate to humans", async () => {
    const human = { id: "owner", name: "Person", role: "admin" as const };
    expect((await humanNotesActor(human, "tenant", "project")).canEdit).toBe(false);
    db.membership.findUnique.mockResolvedValue({ role: "owner" });
    expect((await humanNotesActor(human, "tenant", "project")).canEdit).toBe(true);
  });
  it("represents absent notes explicitly", async () => {
    db.projectNotes.findUnique.mockResolvedValue(null);
    expect(await readProjectNotes({ ...actor, canEdit: false })).toEqual({ notes: null, version: 0, canEdit: false });
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
  it("turns a concurrent first-create collision into a conflict", async () => {
    db.projectNotes.create.mockRejectedValue({ code: "P2002" });
    await expect(saveProjectNotes(actor, input)).rejects.toMatchObject({ status: 409 });
  });
  it("rolls back when required auditing fails", async () => {
    db.agentAuditEvent.create.mockRejectedValue(new Error("audit unavailable"));
    await expect(saveProjectNotes(actor, input)).rejects.toThrow("audit unavailable");
    expect(db.projectNotes.findUniqueOrThrow).not.toHaveBeenCalled();
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
  it("restoration appends a new revision and preserves the old one", async () => {
    db.projectNoteRevision.findFirst.mockResolvedValue({ body: "Old guidance", version: 1 });
    await expect(restoreProjectNotes(actor, "r1", { expectedVersion: 3, reason: "Revert incorrect change" })).resolves.toMatchObject({ version: 4 });
    expect(db.projectNoteRevision.create).toHaveBeenCalledWith({ data: expect.objectContaining({ version: 4, body: "Old guidance", reason: "Restore v1: Revert incorrect change" }) });
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
  it("records a member's upvote as that person's one vote", async () => {
    db.projectNoteComment.findFirst.mockResolvedValue({ id: "comment" });
    db.projectNoteCommentVote.count.mockResolvedValue(2);
    expect(await voteNoteComment(person, "comment", true)).toEqual({ upvoted: true, upvotes: 2 });
    expect(db.projectNoteCommentVote.createMany).toHaveBeenCalledWith({ data: [{ commentId: "comment", userId: "member", agentId: null }], skipDuplicates: true });
  });
});

describe("agent discussion", () => {
  it("attributes comments to verified identity, not payload claims", async () => {
    db.projectNoteComment.create.mockResolvedValue({ id: "comment" });
    await addNoteComment(actor, { body: "See issue 679." });
    expect(db.projectNoteComment.create).toHaveBeenCalledWith({ data: { projectId: "project", agentId: "agent", ownerId: "owner", authorName: "Worker", body: "See issue 679." } });
    await expect(addNoteComment(actor, { body: "Text", agentId: "forged" })).rejects.toThrow();
  });
  it("hides foreign comments before a vote is written", async () => {
    db.projectNoteComment.findFirst.mockResolvedValue(null);
    await expect(voteNoteComment(actor, "foreign", true)).rejects.toMatchObject({ status: 404 });
    expect(db.projectNoteCommentVote.createMany).not.toHaveBeenCalled();
  });
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
  it("returns bounded chronological pages without exposing voter identities", async () => {
    db.projectNoteComment.findMany.mockResolvedValue(["a", "b"].map((id) => ({ id, body: id, createdAt: at, _count: { votes: 3 }, votes: [{ agentId: "agent" }] })));
    const result = await listNoteComments(actor, new URLSearchParams({ limit: "1" }));
    expect(result.items).toEqual([{ id: "a", body: "a", createdAt: at, upvotes: 3, upvoted: true }]);
    expect(result.nextCursor).toBeTruthy();
    expect(notesPage(new URLSearchParams({ cursor: result.nextCursor! })).cursor).toEqual({ id: "a", createdAt: at.toISOString() });
    await listNoteComments(actor, new URLSearchParams({ cursor: result.nextCursor! }));
    expect(db.projectNoteComment.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ projectId: "project", OR: expect.any(Array) }), orderBy: [{ createdAt: "asc" }, { id: "asc" }] }));
  });
  it("lists history newest first", async () => {
    db.projectNoteRevision.findMany.mockResolvedValue([]);
    expect(await listNoteRevisions(actor, new URLSearchParams())).toEqual({ items: [], nextCursor: null });
    expect(db.projectNoteRevision.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: "project" }, take: 21, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }));
  });
  it.each([{ limit: "0" }, { limit: "101" }, { limit: "abc" }, { cursor: "" }, { cursor: "bad!" }])("rejects invalid pagination", (params) => {
    expect(() => notesPage(new URLSearchParams(Object.entries(params).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : [])))).toThrow();
  });
});
