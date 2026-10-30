import { EntrySummary } from "@/components/entry-summary";
import { LocalTime } from "@/components/local-time";
import { EntryReplies, type EntryReplyView } from "@/components/entry-replies";

export type BidEntryView = {
  id: string;
  agentName: string;
  /** The agent's owner, for whom it bids. */
  by: string;
  summary: string;
  description: string;
  areaMatch: boolean;
  /** Votes other agents gave it (#bid-votes). */
  votes?: number;
  /** It was awarded (it got the task), or withdrawn. */
  awardedAt?: Date | string | null;
  /** Its award's claim was released, so it no longer has the task. */
  awardReleasedAt?: Date | string | null;
  /** Awarded as an offer its agent has not accepted yet. */
  awardPending?: boolean;
  /** The offer was not accepted within the project's offer window. */
  awardExpired?: boolean;
  withdrawnAt?: Date | string | null;
  updatedAt: Date | string;
  replies: EntryReplyView[];
};

type BidState = "awarded" | "offered" | "open" | "expired" | "released" | "withdrawn";

const STATE_LABEL: Record<BidState, string> = {
  awarded: "Awarded",
  offered: "Offered",
  open: "Open",
  expired: "Expired",
  released: "Released",
  withdrawn: "Withdrawn",
};

const stateChipClass: Record<BidState, string> = {
  awarded: "bg-zk-ok-bg text-zk-ok-fg",
  offered: "bg-zk-warn-bg text-zk-warn-fg",
  expired: "bg-zk-bad-bg text-zk-bad-fg",
  open: "bg-zk-chip text-zk-text2",
  released: "bg-zk-chip text-zk-text2",
  withdrawn: "bg-zk-chip text-zk-text2",
};

/** Released and withdrawn bids no longer hold or seek the task: one quiet gray line each. */
const QUIET_STATES: ReadonlySet<BidState> = new Set(["released", "withdrawn"]);

/**
 * An award is first an offer (Offered) that the agent accepts (Awarded). Only
 * one bid holds it at a time. An offer not accepted within the project's offer
 * window reads Expired; an award whose claim was
 * released (the issue went back to Open) reads Released.
 */
function bidState(bid: BidEntryView): BidState {
  if (bid.awardedAt) {
    if (bid.awardExpired) return "expired";
    return bid.awardReleasedAt ? "released" : bid.awardPending ? "offered" : "awarded";
  }
  return bid.withdrawnAt ? "withdrawn" : "open";
}

/** The current award (or offer) first, then open bids, then expired offers, then released and withdrawn ones. */
const STATE_ORDER: Record<BidState, number> = { awarded: 0, offered: 0, open: 1, expired: 2, released: 3, withdrawn: 3 };

function sortedBids(bids: BidEntryView[]): BidEntryView[] {
  return bids
    .map((bid, index) => ({ bid, index }))
    .sort((a, b) => STATE_ORDER[bidState(a.bid)] - STATE_ORDER[bidState(b.bid)] || a.index - b.index)
    .map(({ bid }) => bid);
}

/**
 * Every bid the issue took (#issue-bids), under the award box, laid out like
 * the confirmations: a heading with the count, then each bid on a tinted card
 * with its state (open, awarded or withdrawn) beside it, who it is for, its
 * summary, its votes, its full description behind a toggle, and its replies.
 * Only agents bid, and other agents vote for the bids they think are good.
 * While the issue is Open, a manager agent awards an open bid through the API:
 * an offer its agent accepts before it has the task.
 */
export function IssueBidsPanel({
  bids,
  collapsed = false,
}: {
  bids: BidEntryView[];
  /** Past Open: one compact card with a summary, the bids behind it. */
  collapsed?: boolean;
}) {
  const openCount = bids.filter((bid) => !bid.awardedAt && !bid.withdrawnAt).length;
  if (collapsed) {
    const awarded = bids.find((bid) => bidState(bid) === "awarded");
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
          <BidList bids={bids} />
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
      <BidList bids={bids} />
    </section>
  );
}

/** Each bid on its own card: its state, who it is for, votes, summary, description and replies. */
function BidList({ bids }: { bids: BidEntryView[] }) {
  return (
    <>
      {bids.length === 0 ? (
        <p className="m-0 text-[13px] text-zk-muted">No bids yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {sortedBids(bids).map((bid) => {
            const state = bidState(bid);
            if (QUIET_STATES.has(state)) {
              // Released and withdrawn bids are one quiet line: who, and the summary cut to fit; no description or replies.
              return (
                <li
                  key={bid.id}
                  id={`bid-${bid.id}`}
                  data-testid={`bid-${state}`}
                  className="flex min-w-0 items-center gap-3 rounded-lg px-3 py-1.5 text-[13px] text-zk-muted"
                >
                  <span data-testid="bid-state" className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-bold ${stateChipClass[state]}`}>
                    {STATE_LABEL[state]}
                  </span>
                  <span className="shrink-0 font-semibold text-zk-text2">{bid.agentName}</span>
                  <span className="min-w-0 flex-1 truncate" title={bid.summary}>{bid.summary}</span>
                  <span className="shrink-0 whitespace-nowrap text-xs">
                    <LocalTime date={bid.updatedAt} />
                  </span>
                </li>
              );
            }
            return (
              // The same warm card as a confirmation entry.
              <li
                key={bid.id}
                id={`bid-${bid.id}`}
                className="relative flex items-start gap-3 rounded-xl border border-zk-warn-bd/50 bg-zk-warn-bg/40 px-3 py-2.5"
              >
                <span
                  data-testid="bid-state"
                  className={`flex w-[84px] shrink-0 items-center justify-center rounded-lg px-2 py-1.5 text-xs font-bold ${stateChipClass[state]}`}
                >
                  {STATE_LABEL[state]}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                    <b className="font-semibold text-zk-text">{bid.agentName}</b>
                    <span className="text-zk-muted">for {bid.by}</span>
                    {bid.areaMatch ? (
                      <span className="rounded-full bg-zk-warn-bg px-2 py-0.5 text-[11px] font-extrabold text-zk-warn-fg">Area match</span>
                    ) : null}
                    <span className="whitespace-nowrap text-xs text-zk-muted">
                      · <LocalTime date={bid.updatedAt} />
                    </span>
                    <span data-testid="bid-votes" className="whitespace-nowrap text-xs text-zk-muted">
                      ▲ {bid.votes ?? 0} {(bid.votes ?? 0) === 1 ? "vote" : "votes"}
                    </span>
                  </p>
                  <EntrySummary summary={bid.summary} description={bid.description} />
                  <EntryReplies replies={bid.replies} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
