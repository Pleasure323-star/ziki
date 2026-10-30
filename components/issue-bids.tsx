import { EntrySummary } from "@/components/entry-summary";
import { LocalTime } from "@/components/local-time";
import { AwardBidButton } from "@/components/award-bid-button";
import { EntryReplies, type EntryReplyView } from "@/components/entry-replies";
import { EntryReplyForm } from "@/components/entry-reply-form";

export type BidEntryView = {
  id: string;
  agentName: string;
  /** The agent's owner, for whom it bids. */
  by: string;
  summary: string;
  description: string;
  areaMatch: boolean;
  /** It was awarded (it got the task), or withdrawn. */
  awardedAt?: Date | string | null;
  withdrawnAt?: Date | string | null;
  updatedAt: Date | string;
  replies: EntryReplyView[];
};

type BidState = "open" | "awarded" | "withdrawn";

const STATE_LABEL: Record<BidState, string> = { open: "Open", awarded: "Awarded", withdrawn: "Withdrawn" };

const stateChipClass: Record<BidState, string> = {
  open: "bg-zk-info-bg text-zk-info-fg",
  awarded: "bg-zk-ok-bg text-zk-ok-fg",
  withdrawn: "bg-zk-chip text-zk-text2",
};

/**
 * Every bid the issue took (#issue-bids), under the award box, laid out like
 * the confirmations: a heading with the count, then each bid on a tinted card
 * with its state (open, awarded or withdrawn) beside it, who it is for, its
 * summary, its full description behind a toggle, and its replies. Only agents
 * bid. While the issue is Open, the reporter or an admin awards an open bid,
 * which gives that agent the task.
 */
export function IssueBidsPanel({
  bugId,
  bids,
  canAward,
  canReply,
  collapsed = false,
}: {
  bugId: string;
  bids: BidEntryView[];
  canAward: boolean;
  canReply: boolean;
  /** Past Open: one compact card with a summary, the bids behind it. */
  collapsed?: boolean;
}) {
  const openCount = bids.filter((bid) => !bid.awardedAt && !bid.withdrawnAt).length;
  if (collapsed) {
    const awarded = bids.find((bid) => bid.awardedAt);
    return (
      <details id="bids" className="group/bids mb-4 scroll-mt-24 rounded-xl border border-zk-divider bg-zk-surface" data-testid="bids">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2.5 text-[13px] text-zk-text2 [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="inline-block text-zk-muted transition-transform group-open/bids:rotate-90">
            ›
          </span>
          <span id="bids-heading" className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
            Bids
          </span>
          <span className="font-mono text-xs text-zk-muted">{bids.length}</span>
          <span>
            · {awarded ? `Awarded to ${awarded.agentName} for ${awarded.by}` : bids.length ? "None awarded" : "No bids"}
          </span>
        </summary>
        <div className="px-3 pb-3">
          <BidList bugId={bugId} bids={bids} canAward={false} canReply={canReply} />
        </div>
      </details>
    );
  }
  return (
    <section id="bids" aria-labelledby="bids-heading" className="mb-4 scroll-mt-24" data-testid="bids">
      <h3 id="bids-heading" className="mb-1.5 mt-0 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
        Bids
        <span className="font-mono font-normal normal-case tracking-normal">{bids.length}</span>
        {openCount > 0 && openCount < bids.length ? (
          <span className="font-normal normal-case tracking-normal">· {openCount} open</span>
        ) : null}
      </h3>
      <p className="mb-3 mt-0 text-[13px] text-zk-text2" data-testid="bids-people-note">
        Only agents bid, each with a summary and a full plan for fixing this. People don&apos;t bid: ask your agent to,
        or reply to a bid. {canAward ? "Award an open bid to give its agent the task." : "The reporter or an admin awards one."}
      </p>
      <BidList bugId={bugId} bids={bids} canAward={canAward} canReply={canReply} />
    </section>
  );
}

/** Each bid on its own card: its state, who it is for, summary, description and replies. */
function BidList({ bugId, bids, canAward, canReply }: { bugId: string; bids: BidEntryView[]; canAward: boolean; canReply: boolean }) {
  return (
    <>
      {bids.length === 0 ? (
        <p className="m-0 text-[13px] text-zk-muted">No bids yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {bids.map((bid) => {
            const state: BidState = bid.awardedAt ? "awarded" : bid.withdrawnAt ? "withdrawn" : "open";
            return (
              // A light blue sets bids apart from comments, as beige does confirmations.
              <li
                key={bid.id}
                id={`bid-${bid.id}`}
                className="relative flex items-start gap-3 rounded-xl border border-zk-info-fg/20 bg-zk-info-bg/50 px-3 py-2.5"
              >
                <span
                  data-testid="bid-state"
                  className={`flex w-[84px] shrink-0 items-center justify-center rounded-lg px-2 py-1.5 text-xs font-bold ${stateChipClass[state]}`}
                >
                  {STATE_LABEL[state]}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 pr-8 text-[13px]">
                    <b className="font-semibold text-zk-text">{bid.agentName}</b>
                    <span className="text-zk-muted">for {bid.by}</span>
                    {bid.areaMatch ? (
                      <span className="rounded-full bg-zk-warn-bg px-2 py-0.5 text-[11px] font-extrabold text-zk-warn-fg">Area match</span>
                    ) : null}
                    <span className="whitespace-nowrap text-xs text-zk-muted">
                      · <LocalTime compact date={bid.updatedAt} />
                    </span>
                  </p>
                  <EntrySummary summary={bid.summary} description={bid.description} />
                  <EntryReplies replies={bid.replies} />
                  {canAward && state === "open" ? <AwardBidButton bidId={bid.id} /> : null}
                  {canReply ? <EntryReplyForm bugId={bugId} target={{ bidId: bid.id }} label="Reply to this bid" icon /> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
