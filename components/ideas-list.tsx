import Link from "next/link";
import { IdeaScoreBadge } from "@/components/idea-verdicts";
import { IdeaRowStatus } from "@/components/issue-row-status";
import { LocalTime } from "@/components/local-time";
import { ideaPath } from "@/lib/issue-ref";

export type IdeaListRow = {
  id: string;
  number: number;
  title: string;
  score: number;
  /** The project's `ideaThreshold`; null when it could not be read. */
  threshold: number | null;
  createdAt: Date;
  reporterName: string | null;
  platform: string | null;
  verdicts: number;
  /** A manager agent rejected it (#idea-rejected). */
  rejected?: boolean;
  /** A manager agent archived it (#idea-archive): the reason in words, e.g. "Already implemented". */
  archived?: string | null;
  /** Bad: manager agents are advised to reject it (lib/idea-rejection.ts). */
  bad?: boolean;
  /** Weighted good and bad votes (#724), shown as columns; 0 when nobody voted. */
  good: number;
  badVotes: number;
};

/**
 * The Ideas tab's New ideas, Drafted and Rejected ideas lists (#idea-table, #idea-rejected). Ideas are not issues: they
 * have their own numbers and pages, take verdicts instead of votes, and
 * leave this list once an agent converts them.
 */
/** A column heading that sorts the list by it (#724), and back to score order when it already does. */
function SortHeading({ label, column, sort, sortHref, className }: {
  label: React.ReactNode;
  column: "good" | "bad";
  sort?: "good" | "bad" | null;
  sortHref?: (sort: "good" | "bad" | null) => string;
  className: string;
}) {
  if (!sortHref) return <span className={className}>{label}</span>;
  const active = sort === column;
  return (
    <Link href={sortHref(active ? null : column)} aria-sort={active ? "descending" : undefined} className={`${className} hover:text-zk-text ${active ? "text-zk-text" : ""}`}>
      {label}
    </Link>
  );
}

/** The good and bad vote counts on a row (#724), with names a screen reader reads. */
function VoteCounts({ good, bad }: { good: number; bad: number }) {
  return (
    <>
      <span className="w-[44px] shrink-0 text-center font-mono text-[13px] font-semibold tabular-nums text-zk-ok-fg" title={`${good} good`} data-testid="idea-good-votes">
        <span className="sr-only">Good votes: </span>{good}
      </span>
      <span className="w-[44px] shrink-0 text-center font-mono text-[13px] font-semibold tabular-nums text-zk-bad-fg" title={`${bad} bad`} data-testid="idea-bad-votes">
        <span className="sr-only">Bad votes: </span>{bad}
      </span>
    </>
  );
}

export function IdeasList({ ideas, empty, sort, sortHref }: {
  ideas: IdeaListRow[];
  empty?: string;
  sort?: "good" | "bad" | null;
  sortHref?: (sort: "good" | "bad" | null) => string;
}) {
  if (ideas.length === 0) {
    return (
      <div className="rounded-[20px] border border-zk-border bg-zk-surface px-4 py-12 text-center">
        <p className="font-bold text-zk-text">Nothing here right now.</p>
        <p className="mt-1.5 text-sm text-zk-muted">
          {empty ?? "New ideas show up here until an agent converts them to issues."}
        </p>
      </div>
    );
  }
  return (
    <section className="issues-results flex flex-col gap-3.5" aria-label="Ideas">
      <div className="issues-table relative">
        <div>
          <div className="issues-table-heading">
            <span className="w-[52px]">Score</span>
            <span className="min-w-0 flex-1">Idea</span>
            <SortHeading label={<><span aria-hidden="true">✓ </span>Good</>} column="good" sort={sort} sortHref={sortHref} className="hidden w-[44px] shrink-0 text-center md:inline" />
            <SortHeading label={<><span aria-hidden="true">✕ </span>Bad</>} column="bad" sort={sort} sortHref={sortHref} className="hidden w-[44px] shrink-0 text-center md:inline" />
            <span className="issues-status-cell">Status</span>
          </div>
          <ul>
            {ideas.map((idea, index) => (
              <li
                key={idea.id}
                data-testid="idea-row"
                className={`issues-row flex items-center gap-2 px-2 py-3.5 lg:gap-4 lg:px-4 ${
                  index < ideas.length - 1 ? "border-b border-zk-divider" : ""
                }`}
              >
                <div className="issues-vote w-[52px] shrink-0">
                  <IdeaScoreBadge score={idea.score} threshold={idea.threshold} bad={idea.bad} />
                </div>
                <Link
                  href={ideaPath(idea.number)}
                  className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-electric-blue"
                >
                  <span className="issues-row-title text-sm font-semibold leading-snug text-zk-text">{idea.title}</span>
                  <span className="issues-row-meta flex flex-wrap items-center gap-2 text-xs text-zk-muted">
                    <span className="font-mono tabular-nums">Idea #{idea.number}</span>
                    {idea.reporterName ? <span>{idea.reporterName}</span> : null}
                    <span>
                      {idea.verdicts} verdict{idea.verdicts === 1 ? "" : "s"}
                    </span>
                    {/* Phones: the counts in the meta line; wider screens have the columns. */}
                    <span className="md:hidden">✓ {idea.good} · ✕ {idea.badVotes}</span>
                    {idea.platform ? <span>{idea.platform}</span> : null}
                    <LocalTime date={idea.createdAt} />
                    <span className="inline-flex min-w-0 md:sr-only">
                      <IdeaRowStatus score={idea.score} threshold={idea.threshold} rejected={idea.rejected} archived={idea.archived} bad={idea.bad} />
                    </span>
                  </span>
                </Link>
                <span className="hidden items-center md:flex">
                  <VoteCounts good={idea.good} bad={idea.badVotes} />
                </span>
                <span className="issues-status-cell" aria-hidden="true">
                  <IdeaRowStatus score={idea.score} threshold={idea.threshold} rejected={idea.rejected} archived={idea.archived} bad={idea.bad} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
