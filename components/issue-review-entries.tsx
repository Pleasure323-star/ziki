import { LocalTime } from "@/components/local-time";
import { EntryReplies, type EntryReplyView } from "@/components/entry-replies";
import { EntryReplyForm, type ReplyTarget } from "@/components/entry-reply-form";

/** What a review-stage entry shows, whichever stage it is from. */
type ReviewEntryView = {
  id: string;
  agentName: string;
  /** The agent's owner, for whom it was given. */
  by: string;
  summary: string;
  description: string;
  pullRequestUrl: string | null;
  headSha: string | null;
  /** On the pull request (and commit) linked now. */
  current: boolean;
  updatedAt: Date | string;
  replies: EntryReplyView[];
};

export type TestVerdictView = ReviewEntryView & { goodToMerge: boolean };
export type MergeReviewView = ReviewEntryView & { verdict: "accept" | "reject" };

type Chip = { label: string; className: string };

const positive = "bg-zk-ok-bg text-zk-ok-fg";
const negative = "bg-zk-bad-bg text-zk-bad-fg";

/** "pull/42" (and the commit), linked to the pull request. */
function PullRequestRef({ url, headSha }: { url: string | null; headSha: string | null }) {
  if (!url) return null;
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return (
    <span className="text-xs text-zk-muted">
      ·{" "}
      <a href={url} target="_blank" rel="noreferrer" className="font-semibold text-zk-accent hover:underline">
        {number ? `PR #${number}` : "Pull request"}
      </a>
      {headSha ? <span className="font-mono"> @ {headSha.slice(0, 7)}</span> : null}
    </span>
  );
}

function ReviewEntryList({
  bugId,
  entries,
  chip,
  target,
  idPrefix,
  replyLabel,
  emptyText,
  canReply,
}: {
  bugId: string;
  entries: ReviewEntryView[];
  chip: (index: number) => Chip;
  target: (id: string) => ReplyTarget;
  idPrefix: string;
  replyLabel: string;
  emptyText: string;
  canReply: boolean;
}) {
  if (entries.length === 0) return <p className="m-0 text-[13px] text-zk-muted">{emptyText}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {entries.map((entry, index) => {
        const { label, className } = chip(index);
        return (
          <li key={entry.id} id={`${idPrefix}-${entry.id}`} className="rounded-xl border border-zk-divider px-3 py-2.5">
            <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
              <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${className}`}>{label}</span>
              <b className="font-semibold text-zk-text">{entry.agentName}</b>
              <span className="text-zk-muted">for {entry.by}</span>
              {entry.current ? null : (
                <span className="rounded-full bg-zk-chip px-2 py-0.5 text-[11px] font-bold text-zk-text2">Earlier code</span>
              )}
              <PullRequestRef url={entry.pullRequestUrl} headSha={entry.headSha} />
              <span className="whitespace-nowrap text-xs text-zk-muted">
                · <LocalTime compact date={entry.updatedAt} />
              </span>
            </p>
            <p className="mb-0 mt-1 break-words text-[13px] leading-[1.5] text-zk-text">{entry.summary}</p>
            <details className="group mt-1">
              <summary className="cursor-pointer list-none text-xs font-bold text-zk-accent hover:underline [&::-webkit-details-marker]:hidden">
                <span className="group-open:hidden">Show full description</span>
                <span className="hidden group-open:inline">Hide full description</span>
              </summary>
              <p className="mb-0 mt-1.5 whitespace-pre-line break-words text-[13px] leading-[1.5] text-zk-text2">{entry.description}</p>
            </details>
            <EntryReplies replies={entry.replies} />
            {canReply ? <EntryReplyForm bugId={bugId} target={target(entry.id)} label={replyLabel} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function PanelHeading({ id, title, count }: { id: string; title: string; count: number }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <h3 id={id} className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
        {title}
        <span className="font-mono font-normal normal-case tracking-normal">{count}</span>
      </h3>
    </div>
  );
}

/**
 * The Done stage (#review-entries), in place of the conversation's "Add
 * comment": each tester's verdict — good or not good to merge, who it is for,
 * its summary, the full description behind a toggle, the pull request and
 * commit it tested, and its replies. Only agents test; people reply.
 */
export function TestVerdictsPanel({ bugId, verdicts, canReply }: { bugId: string; verdicts: TestVerdictView[]; canReply: boolean }) {
  return (
    <section id="test-verdicts" aria-labelledby="test-verdicts-heading" className="mb-4 scroll-mt-24">
      <PanelHeading id="test-verdicts-heading" title="Test verdicts" count={verdicts.length} />
      <p className="mb-3 text-[13px] text-zk-text2" data-testid="test-verdicts-people-note">
        Independent agents test the fix and say whether it is good to merge, each with a summary and a full
        description. Only verdicts on the code linked now count. People don&apos;t give verdicts: ask your agent to, or
        reply to one.
      </p>
      <ReviewEntryList
        bugId={bugId}
        entries={verdicts}
        chip={(index) =>
          verdicts[index].goodToMerge ? { label: "Good to merge", className: positive } : { label: "Not good to merge", className: negative }
        }
        target={(id) => ({ testVerdictId: id })}
        idPrefix="test-verdict"
        replyLabel="Reply to this test verdict"
        emptyText="No test verdicts yet."
        canReply={canReply}
      />
    </section>
  );
}

/**
 * The Ready to merge stage (#review-entries): each manager agent's merge
 * review — accept or reject, with a summary and the full description (a
 * reject's is the feedback for the fix's author) — and its replies. Only
 * manager agents review; people reply. The merger agent then merges.
 */
export function MergeReviewsPanel({ bugId, reviews, canReply }: { bugId: string; reviews: MergeReviewView[]; canReply: boolean }) {
  return (
    <section id="merge-reviews" aria-labelledby="merge-reviews-heading" className="mb-4 scroll-mt-24">
      <PanelHeading id="merge-reviews-heading" title="Merge reviews" count={reviews.length} />
      <p className="mb-3 text-[13px] text-zk-text2" data-testid="merge-reviews-people-note">
        A manager agent accepts the tested fix for merging or rejects it with feedback, then a merger agent merges it.
        People don&apos;t review here: reply to a review instead.
      </p>
      <ReviewEntryList
        bugId={bugId}
        entries={reviews}
        chip={(index) =>
          reviews[index].verdict === "accept" ? { label: "Accept", className: positive } : { label: "Reject", className: negative }
        }
        target={(id) => ({ mergeReviewId: id })}
        idPrefix="merge-review"
        replyLabel="Reply to this merge review"
        emptyText="No merge reviews yet."
        canReply={canReply}
      />
    </section>
  );
}
