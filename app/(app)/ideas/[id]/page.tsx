import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth-helpers";
import { currentTenantIdFor } from "@/lib/tenant-context";
import { issuePath, parseIssueRef } from "@/lib/issue-ref";
import { IDEA_SUMMARY_MAX_CHARS, listIdeaVerdicts } from "@/lib/agent-api/idea-verdicts";
import { IdeaVerdictsPanel, type IdeaVerdictBlock } from "@/components/idea-verdicts";
import { AttachmentList } from "@/components/attachment-list";
import { RichText } from "@/components/rich-text";
import { LocalTime } from "@/components/local-time";

export const metadata: Metadata = { title: "Idea" };

/** The Ideas tab, where ideas are opened from. */
const NEW_IDEAS_HREF = "/issues";

type LegacyComment = { authorId: string; body: string; createdAt: string };

function legacyComments(value: unknown): LegacyComment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is LegacyComment =>
      !!row && typeof row === "object" && typeof (row as LegacyComment).body === "string" && typeof (row as LegacyComment).authorId === "string",
  );
}

const STATUS_CHIP: Record<string, { label: string; className: string }> = {
  open: { label: "Idea", className: "bg-zk-tint text-zk-accent" },
  converted: { label: "Converted to an issue", className: "bg-zk-ok-bg text-zk-ok-fg" },
  closed: { label: "Closed", className: "bg-zk-chip text-zk-muted" },
};

/**
 * One idea (#idea-table). An idea is not an issue: it takes verdicts, not
 * comments or votes, and a manager agent converts it once its score reaches
 * the project's threshold. A converted idea links to the issue it became.
 */
export default async function IdeaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const tenantId = await currentTenantIdFor(user.id);
  if (!tenantId) notFound();
  const ref = parseIssueRef(id);
  const idea = await prisma.idea.findFirst({
    where: { tenantId, isDeleted: false, ...(ref.kind === "number" ? { number: ref.number } : { id: ref.id }) },
    select: {
      id: true,
      number: true,
      title: true,
      description: true,
      status: true,
      projectId: true,
      createdAt: true,
      reporterId: true,
      beneficiaryUserId: true,
      legacyComments: true,
      reporter: { select: { name: true } },
      createdByAgent: { select: { name: true, ownerUserId: true } },
      category: { select: { name: true } },
      type: { select: { name: true } },
      area: { select: { name: true } },
      issue: { select: { number: true, title: true } },
      attachments: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, filename: true, contentType: true, size: true },
      },
    },
  });
  if (!idea) notFound();

  const verdicts = await listIdeaVerdicts({ tenantId, projectId: idea.projectId }, idea.id);
  const own = idea.reporterId === user.id || idea.beneficiaryUserId === user.id || idea.createdByAgent?.ownerUserId === user.id;
  const block: IdeaVerdictBlock = idea.status !== "open" ? "closed" : own ? "own" : null;
  const chip = STATUS_CHIP[idea.status] ?? STATUS_CHIP.open;
  const earlier = legacyComments(idea.legacyComments);
  const authors = earlier.length
    ? new Map(
        (await prisma.user.findMany({ where: { id: { in: [...new Set(earlier.map((c) => c.authorId))] } }, select: { id: true, name: true } }))
          .map((u) => [u.id, u.name]),
      )
    : new Map<string, string | null>();

  return (
    <div className="flex flex-col gap-5 pb-10">
      {/* Header like an issue's: back to the Ideas tab, number + title. */}
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <Link
            href={NEW_IDEAS_HREF}
            aria-label="Back to ideas"
            title="Back to ideas"
            className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zk-accent hover:bg-zk-chip print:hidden"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </Link>
          <h1 className="min-w-0 break-words text-[28px] font-extrabold leading-tight tracking-[-0.02em] text-zk-text">
            <span className="font-bold tabular-nums text-zk-muted">Idea #{idea.number}</span> {idea.title}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="idea-status" className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${chip.className}`}>{chip.label}</span>
          {idea.issue ? (
            <Link href={issuePath(idea.issue.number)} data-testid="idea-issue-link" className="text-sm font-bold text-zk-accent hover:underline">
              Issue #{idea.issue.number}
            </Link>
          ) : null}
          <span className="text-[13px] text-zk-muted">
            {idea.reporter.name ?? "Someone"}
            {idea.createdByAgent ? ` via ${idea.createdByAgent.name}` : ""} · <LocalTime date={idea.createdAt} />
            {idea.type ? ` · ${idea.type.name}` : ""}
            {idea.category ? ` · ${idea.category.name}` : ""}
            {idea.area ? ` · ${idea.area.name}` : ""}
          </span>
        </div>
      </div>

      <section className="rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-6">
        <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Description</h2>
        <RichText content={idea.description} className="mt-3 text-sm text-zk-text" />
      </section>

      {idea.attachments.length > 0 ? (
        <section className="rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-6">
          <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Attachments</h2>
          <AttachmentList attachments={idea.attachments} />
        </section>
      ) : null}

      <IdeaVerdictsPanel ideaId={idea.id} data={verdicts} viewerId={user.id} block={block} summaryMaxChars={IDEA_SUMMARY_MAX_CHARS} />

      {earlier.length > 0 ? (
        <section className="rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-6" aria-labelledby="earlier-comments">
          <h2 id="earlier-comments" className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
            Earlier comments
          </h2>
          <p className="mt-1 text-[13px] text-zk-muted">Left before ideas took verdicts instead of comments.</p>
          <ul className="mt-3 flex flex-col gap-2.5">
            {earlier.map((comment, index) => (
              <li key={index} className="rounded-xl border border-zk-divider px-3 py-2.5 text-[13px]">
                <p className="m-0 text-xs text-zk-muted">
                  <b className="font-semibold text-zk-text">{authors.get(comment.authorId) ?? "Someone"}</b> · <LocalTime compact date={comment.createdAt} />
                </p>
                <RichText content={comment.body} className="mt-1 text-zk-text" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
