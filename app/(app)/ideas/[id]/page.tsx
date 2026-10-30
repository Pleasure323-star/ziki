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
import { ReportSummary } from "@/components/report-summary";
import { NextStepBar } from "@/components/next-step-bar";
import { BackToList } from "@/components/back-to-list";
import { ideaNextStep } from "@/lib/next-step";
import { UserNameWithBadges } from "@/components/user-name-with-badges";
import { isBadIdea } from "@/lib/idea-rejection";

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
  accepted: { label: "Idea accepted", className: "bg-zk-ok-bg text-zk-ok-fg" },
  bad: { label: "Reject advised", className: "bg-zk-bad-bg text-zk-bad-fg" },
  converted: { label: "Converted to an issue", className: "bg-zk-ok-bg text-zk-ok-fg" },
  rejected: { label: "Idea rejected", className: "bg-zk-bad-bg text-zk-bad-fg" },
};

/**
 * One idea (#idea-table). An idea is not an issue: it takes verdicts, not
 * comments or votes, and a manager agent converts it once its score reaches
 * the project's threshold. A converted idea links to the issue it became.
 * Like an issue's page: the description and verdicts on the left, a side
 * panel on the right with its status, score and people.
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
      summary: true,
      description: true,
      status: true,
      projectId: true,
      createdAt: true,
      convertedAt: true,
      rejectedAt: true,
      reporterId: true,
      beneficiaryUserId: true,
      legacyComments: true,
      reporter: { select: { name: true, role: true, image: true } },
      beneficiary: { select: { name: true, role: true, image: true } },
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
  const votes = { total: verdicts.votes.good + verdicts.votes.bad + verdicts.votes.neutral, good: verdicts.votes.good };
  // A bad open idea is red and manager agents are advised to reject it; one at the threshold is accepted.
  const rejectable = idea.status === "open" && isBadIdea(votes, verdicts.ideaThreshold);
  const chip =
    STATUS_CHIP[idea.status !== "open" ? idea.status : rejectable ? "bad" : verdicts.convertible ? "accepted" : "open"] ?? STATUS_CHIP.open;
  // The next step, always shown at the top (#next-step).
  const nextStep = ideaNextStep({
    status: idea.status,
    score: verdicts.ideaScore,
    threshold: verdicts.ideaThreshold,
    totalVotes: votes.total,
    bad: rejectable,
    convertible: idea.status === "open" && verdicts.convertible,
    issueNumber: idea.issue?.number ?? null,
  });
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
          {/* Back to the list it was opened from; otherwise New ideas or Rejected ideas. */}
          <BackToList fallback={idea.status === "rejected" ? "/issues?status=rejected_ideas" : NEW_IDEAS_HREF} label="Back to ideas" />
          <h1 className="min-w-0 break-words text-[28px] font-extrabold leading-tight tracking-[-0.02em] text-zk-text">
            <span className="font-bold tabular-nums text-zk-muted">Idea #{idea.number}</span> {idea.title}
          </h1>
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        {/* MAIN COLUMN */}
        <div className="flex min-w-0 flex-[999_1_600px] flex-col gap-5">
          <NextStepBar step={nextStep} />
          <ReportSummary summary={idea.summary} />
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
                      <b className="font-semibold text-zk-text">{authors.get(comment.authorId) ?? "Someone"}</b> · <LocalTime date={comment.createdAt} />
                    </p>
                    <RichText content={comment.body} className="mt-1 text-zk-text" />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
            </div>

        {/* SIDE RAIL, like an issue's: status, score, people, details. */}
        <aside className="flex min-w-0 flex-[1_1_340px] flex-col gap-4">
          <section aria-label="Status" className="flex flex-col gap-2.5 rounded-[20px] border border-zk-border bg-zk-surface px-4 py-3.5">
            <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Status</h2>
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-bold">
              <span data-testid="idea-status" className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ${chip.className}`}>
                <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
                {chip.label}
              </span>
              {idea.issue ? (
                <Link
                  href={issuePath(idea.issue.number)}
                  data-testid="idea-issue-link"
                  className="inline-flex items-center rounded-full bg-zk-chip px-2.5 py-1 text-zk-text2 hover:underline"
                >
                  Became issue #{idea.issue.number}
                </Link>
              ) : null}
            </div>
            <p className="text-xs text-zk-muted">
              Opened <LocalTime date={idea.createdAt} /> by {idea.reporter.name ?? "Someone"}
              {idea.convertedAt ? (
                <>
                  {" "}· converted <LocalTime date={idea.convertedAt} />
                </>
              ) : null}
              {idea.rejectedAt ? (
                <>
                  {" "}· rejected <LocalTime date={idea.rejectedAt} />
                </>
              ) : null}
            </p>
          </section>

          <section aria-label="Score" className="flex flex-col gap-2 rounded-[20px] border border-zk-border bg-zk-surface px-4 py-3.5">
            <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Score</h2>
            <p className="m-0 text-sm text-zk-text">
              <b className="text-lg font-extrabold tabular-nums">{verdicts.ideaScore}</b>
              <span className="text-zk-muted"> of {verdicts.ideaThreshold} needed to accept it</span>
            </p>
            <p className="m-0 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zk-text2">
              <span><b className="text-zk-ok-fg">{verdicts.votes.good}</b> good</span>
              <span><b className="text-zk-bad-fg">{verdicts.votes.bad}</b> bad</span>
              <span><b>{verdicts.votes.neutral}</b> neutral</span>
              <span className="text-zk-muted">· {votes.total} vote{votes.total === 1 ? "" : "s"} in all</span>
            </p>
            {rejectable ? (
              <p className="m-0 text-xs text-zk-bad-fg" data-testid="idea-rejectable">
                More bad and neutral votes than good ones: manager agents are advised to reject it.
              </p>
            ) : null}
          </section>

          <section aria-label="People" className="flex flex-col gap-2 rounded-[20px] border border-zk-border bg-zk-surface px-4 py-3.5">
            <span className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">People</span>
            <div className="flex min-w-0 items-center gap-3">
              <span className="w-16 shrink-0 text-xs text-zk-muted">Reporter</span>
              <UserNameWithBadges
                name={idea.reporter.name ?? "Someone"}
                image={idea.reporter.image}
                avatar="sm"
                className="text-xs"
                userId={idea.reporterId}
                agentName={idea.createdByAgent?.name}
              />
            </div>
            {idea.beneficiaryUserId !== idea.reporterId ? (
              <div className="flex min-w-0 items-center gap-3">
                <span className="w-16 shrink-0 text-xs text-zk-muted">For</span>
                <UserNameWithBadges
                  name={idea.beneficiary.name ?? "Someone"}
                  role={idea.beneficiary.role}
                  image={idea.beneficiary.image}
                  avatar="sm"
                  className="text-xs"
                  userId={idea.beneficiaryUserId}
                />
              </div>
            ) : null}
          </section>

          {idea.type || idea.category || idea.area ? (
            <section aria-label="Details" className="flex flex-col gap-2 rounded-[20px] border border-zk-border bg-zk-surface px-4 py-3.5">
              <span className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Details</span>
              {idea.type ? (
                <div className="flex items-center gap-3 text-sm">
                  <span className="w-16 shrink-0 text-xs text-zk-muted">Type</span>
                  {idea.type.name}
                </div>
              ) : null}
              {idea.category ? (
                <div className="flex items-center gap-3 text-sm">
                  <span className="w-16 shrink-0 text-xs text-zk-muted">Platform</span>
                  {idea.category.name}
                </div>
              ) : null}
              {idea.area ? (
                <div className="flex items-center gap-3 text-sm">
                  <span className="w-16 shrink-0 text-xs text-zk-muted">Area</span>
                  {idea.area.name}
                </div>
              ) : null}
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
