import Link from "next/link";
import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { currentTenantIdFor } from "@/lib/tenant-context";
import { activeProjectIdFor } from "@/lib/project-context";
import { humanNotesActor, readProjectNotes, listNoteComments, listNoteRevisions } from "@/lib/project-notes";
import { RichText } from "@/components/rich-text";
import { NotesDocument } from "./notes-document";

export const metadata = { title: "Project notes · Ziki" };
export default async function NotesPage({ searchParams }: { searchParams: Promise<{ cursor?: string; history?: string }> }) {
  const user = await requireUser();
  const tenantId = await currentTenantIdFor(user.id);
  const projectId = tenantId ? await activeProjectIdFor(prisma, tenantId) : null;
  if (!tenantId || !projectId) return (
    <div className="mx-auto w-full max-w-6xl rounded-[20px] border border-zk-border bg-zk-surface p-7">
      <h1 className="font-bold text-zk-text">Project notes</h1>
      <p className="mt-2 text-sm text-zk-text2">Select a workspace and project to read its notes.</p>
      <Link href="/org/projects" className="mt-4 inline-block text-sm font-semibold text-zk-accent underline">View projects</Link>
    </div>
  );
  const params = await searchParams;
  const actor = await humanNotesActor(user, tenantId, projectId);
  const [project, result, comments, revisions] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true } }),
    readProjectNotes(actor),
    listNoteComments(actor, new URLSearchParams(params.cursor ? { cursor: params.cursor } : {})),
    listNoteRevisions(actor, new URLSearchParams({ limit: "10", ...(params.history ? { cursor: params.history } : {}) })),
  ]);
  const pageHref = (key: "cursor" | "history", cursor: string) => {
    const next = new URLSearchParams({ ...(params.cursor ? { cursor: params.cursor } : {}), ...(params.history ? { history: params.history } : {}), [key]: cursor });
    return `/notes?${next}`;
  };
  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm text-zk-text2"><Link href="/issues" className="truncate hover:text-zk-text">{project.name}</Link><span aria-hidden="true">›</span><h1 aria-current="page" className="font-semibold text-zk-text">Notes</h1></nav>
        <Link href="/issues" className="rounded-lg border border-zk-border px-3 py-2 text-sm font-semibold text-zk-text hover:bg-zk-chip">Back to issues</Link>
      </div>
      <NotesDocument key={projectId} projectId={projectId} canEdit={result.canEdit}
        notes={result.notes ? { ...result.notes, updatedAt: result.notes.updatedAt.toISOString() } : null}
        revisions={revisions.items.map((revision) => ({ ...revision, createdAt: revision.createdAt.toISOString() }))}
        historyLink={revisions.nextCursor ? pageHref("history", revisions.nextCursor) : undefined} />
      <section aria-labelledby="notes-discussion-heading" className="rounded-[20px] border border-zk-border bg-zk-surface">
        <div className="border-b border-zk-border px-5 py-4 sm:px-7">
          <h2 id="notes-discussion-heading" className="text-base font-bold text-zk-text">Agent comments</h2>
          <p className="mt-1 text-sm text-zk-text2">Discoveries, corrections and suggestions. Upvotes indicate usefulness; they do not change official guidance.</p>
        </div>
        {comments.items.length ? <ol className="divide-y divide-zk-border px-5 sm:px-7">{comments.items.map((comment) => (
          <li id={`comment-${comment.id}`} key={comment.id} className="py-5">
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-bold text-zk-text">{comment.authorName} <span className="font-normal text-zk-muted">· Agent</span></p><time dateTime={comment.createdAt.toISOString()} className="text-xs text-zk-muted">{comment.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC</time></div>
            <RichText content={comment.body} className="text-zk-text" />
            <p className="mt-3 text-xs font-semibold text-zk-text2" aria-label={`${comment.upvotes} upvotes`}>↑ {comment.upvotes} {comment.upvotes === 1 ? "upvote" : "upvotes"}</p>
          </li>
        ))}</ol> : <p className="px-5 py-10 text-center text-sm text-zk-text2">No agent comments yet. Agents can share discoveries and suggestions through the project notes API.</p>}
        {comments.nextCursor ? <Link href={pageHref("cursor", comments.nextCursor)} className="m-5 inline-block text-sm font-semibold text-zk-accent underline">Next comments</Link> : null}
        {params.cursor || params.history ? <Link href="/notes" className="m-5 inline-block text-sm text-zk-accent underline">Latest notes and first comments</Link> : null}
      </section>
    </div>
  );
}
