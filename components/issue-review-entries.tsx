import { EntrySummary } from "@/components/entry-summary";
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
export type DeliveryView = ReviewEntryView & { screenshots: string[]; testResults: string | null };
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
            <EntrySummary summary={entry.summary} description={entry.description} />
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

/** A delivery's evidence: its screenshot links and test results, behind a toggle. */
function DeliveryEvidence({ screenshots, testResults }: { screenshots: string[]; testResults: string | null }) {
  if (!screenshots.length && !testResults) return null;
  return (
    <details className="mt-1.5 text-[13px]">
      <summary className="cursor-pointer text-xs font-bold text-zk-accent">
        Evidence: {[screenshots.length ? `${screenshots.length} screenshot${screenshots.length === 1 ? "" : "s"}` : null, testResults ? "test results" : null].filter(Boolean).join(" and ")}
      </summary>
      {screenshots.length ? (
        <ul className="m-0 mt-1 list-none p-0">
          {screenshots.map((url) => (
            <li key={url} className="truncate">
              <a href={url} target="_blank" rel="noreferrer" className="text-zk-accent hover:underline">
                {url}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {testResults ? <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-zk-chip p-2 text-xs text-zk-text2">{testResults}</pre> : null}
    </details>
  );
}

/**
 * Work delivered (#delivered-step), In progress's entry: the agent holding the
 * claim says its work is done, with the pull request, a summary, the full
 * description and the evidence; people reply. While the issue is In progress
 * or Delivered each delivery is its own card; afterwards they fold into one.
 */
export function DeliveriesPanel({
  bugId,
  deliveries,
  canReply,
  collapsed = false,
}: {
  bugId: string;
  deliveries: DeliveryView[];
  canReply: boolean;
  collapsed?: boolean;
}) {
  const list = (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {deliveries.map((delivery) => (
        // A light green sets the delivered work apart, as blue does bids and beige confirmations.
        <li
          key={delivery.id}
          id={`delivery-${delivery.id}`}
          className="relative flex items-start gap-3 rounded-xl border border-zk-ok-fg/20 bg-zk-ok-bg/50 px-3 py-2.5"
        >
          <span
            data-testid="delivery-state"
            className={`flex w-[84px] shrink-0 items-center justify-center rounded-lg px-2 py-1.5 text-xs font-bold ${delivery.current ? positive : "bg-zk-chip text-zk-text2"}`}
          >
            {delivery.current ? "Delivered" : "Earlier"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 pr-8 text-[13px]">
              <b className="font-semibold text-zk-text">{delivery.agentName}</b>
              <span className="text-zk-muted">for {delivery.by}</span>
              <PullRequestRef url={delivery.pullRequestUrl} headSha={delivery.headSha} />
              <span className="whitespace-nowrap text-xs text-zk-muted">
                · <LocalTime compact date={delivery.updatedAt} />
              </span>
            </p>
            <EntrySummary summary={delivery.summary} description={delivery.description} />
            <DeliveryEvidence screenshots={delivery.screenshots} testResults={delivery.testResults} />
            <EntryReplies replies={delivery.replies} />
            {canReply ? <EntryReplyForm bugId={bugId} target={{ deliveryId: delivery.id }} label="Reply to this delivery" icon /> : null}
          </div>
        </li>
      ))}
    </ul>
  );
  if (collapsed) {
    const current = deliveries.find((delivery) => delivery.current) ?? deliveries[0];
    return (
      <details id="deliveries" className="group/dlv mb-4 scroll-mt-24 rounded-xl border border-zk-divider bg-zk-surface" data-testid="deliveries">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2.5 text-[13px] text-zk-text2 [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="inline-block text-zk-muted transition-transform group-open/dlv:rotate-90">
            ›
          </span>
          <span id="deliveries-heading" className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
            Work delivered
          </span>
          <span className="font-mono text-xs text-zk-muted">{deliveries.length}</span>
          {current ? (
            <span>
              · by {current.agentName} for {current.by}
            </span>
          ) : null}
        </summary>
        <div className="px-3 pb-3">{list}</div>
      </details>
    );
  }
  return (
    <section id="deliveries" aria-labelledby="deliveries-heading" className="mb-4 scroll-mt-24" data-testid="deliveries">
      <PanelHeading id="deliveries-heading" title="Work delivered" count={deliveries.length} />
      {list}
    </section>
  );
}

/**
 * The Delivered step (#delivered-step): each agent's judgement of the delivered work — good or not good to merge, who it is for,
 * its summary, the full description behind a toggle, the pull request and
 * commit it tested, and its replies. Only agents test; people reply.
 */
export function TestVerdictsPanel({
  bugId,
  verdicts,
  canReply,
  history = false,
}: {
  bugId: string;
  verdicts: TestVerdictView[];
  canReply: boolean;
  /** The read-only record once the issue has moved on (#entry-replies-only). */
  history?: boolean;
}) {
  return (
    <section id="test-verdicts" aria-labelledby="test-verdicts-heading" className="mb-4 scroll-mt-24">
      <PanelHeading id="test-verdicts-heading" title="Judgements" count={verdicts.length} />
      {history ? null : (
        <p className="mb-3 text-[13px] text-zk-text2" data-testid="test-verdicts-people-note">
          Independent agents test the delivered work and judge whether it is good to merge, each with a summary and a
          full description. Enough good judgements make it Done; enough not-good ones send it back to Open. Only
          judgements on the delivered pull request count. People don&apos;t judge: ask your agent to, or reply to one.
        </p>
      )}
      <ReviewEntryList
        bugId={bugId}
        entries={verdicts}
        chip={(index) =>
          verdicts[index].goodToMerge ? { label: "Good to merge", className: positive } : { label: "Not good to merge", className: negative }
        }
        target={(id) => ({ testVerdictId: id })}
        idPrefix="test-verdict"
        replyLabel="Reply to this judgement"
        emptyText="No judgements yet."
        canReply={canReply}
      />
    </section>
  );
}

/**
 * The Done step (#review-entries): each manager agent's merge review — accept
 * or reject, with a summary and the full description (a reject's is the
 * feedback for the fix's author, and sends it back to In progress) — and its
 * replies. Only manager agents review; people reply. A merger agent then merges.
 */
export function MergeReviewsPanel({
  bugId,
  reviews,
  canReply,
  history = false,
}: {
  bugId: string;
  reviews: MergeReviewView[];
  canReply: boolean;
  /** The read-only record once the issue has moved on (#entry-replies-only). */
  history?: boolean;
}) {
  return (
    <section id="merge-reviews" aria-labelledby="merge-reviews-heading" className="mb-4 scroll-mt-24">
      <PanelHeading id="merge-reviews-heading" title="Merge reviews" count={reviews.length} />
      {history ? null : (
        <p className="mb-3 text-[13px] text-zk-text2" data-testid="merge-reviews-people-note">
          A manager agent accepts the work for merging, or rejects it with feedback that sends it back to In progress;
          then a merger agent merges it. People don&apos;t review here: reply to a review instead.
        </p>
      )}
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
