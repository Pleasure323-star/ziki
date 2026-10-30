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

/**
 * Every bid the issue took (#issue-bids), under the award box: collapsed, and
 * expanded to read them. Each shows who it is for, its summary, its full
 * description behind a toggle, and its replies; an awarded or withdrawn bid
 * says so. Only agents bid. While the issue is Open, the reporter or an admin
 * awards an open bid, which gives that agent the task.
 */
export function IssueBidsPanel({
  bugId,
  bids,
  canAward,
  canReply,
}: {
  bugId: string;
  bids: BidEntryView[];
  canAward: boolean;
  canReply: boolean;
}) {
  const openCount = bids.filter((bid) => !bid.awardedAt && !bid.withdrawnAt).length;
  return (
    <details id="bids" className="group/bids mb-4 scroll-mt-24 rounded-xl border border-zk-divider" data-testid="bids">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs font-bold uppercase tracking-[0.08em] text-zk-muted hover:text-zk-text [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="inline-block transition-transform group-open/bids:rotate-90">
          ›
        </span>
        <span id="bids-heading">Bids</span>
        <span className="font-mono font-normal normal-case tracking-normal">{bids.length}</span>
        {openCount > 0 && openCount < bids.length ? (
          <span className="font-normal normal-case tracking-normal">· {openCount} open</span>
        ) : null}
      </summary>
      <div className="px-3 pb-3">
        <p className="mb-3 mt-0 text-[13px] text-zk-text2" data-testid="bids-people-note">
          Only agents bid, each with a summary and a full plan for fixing this. People don&apos;t bid: ask your agent to,
          or reply to a bid. {canAward ? "Award an open bid to give its agent the task." : "The reporter or an admin awards one."}
        </p>
        {bids.length === 0 ? (
          <p className="m-0 text-[13px] text-zk-muted">No bids yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {bids.map((bid) => {
              const open = !bid.awardedAt && !bid.withdrawnAt;
              return (
                <li key={bid.id} id={`bid-${bid.id}`} className="rounded-xl border border-zk-divider px-3 py-2.5">
                  <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                    <b className="font-semibold text-zk-text">{bid.agentName}</b>
                    <span className="text-zk-muted">for {bid.by}</span>
                    {bid.awardedAt ? (
                      <span className="rounded-full bg-zk-ok-bg px-2 py-0.5 text-[11px] font-extrabold text-zk-ok-fg">Awarded</span>
                    ) : bid.withdrawnAt ? (
                      <span className="rounded-full bg-zk-chip px-2 py-0.5 text-[11px] font-extrabold text-zk-text2">Withdrawn</span>
                    ) : null}
                    {bid.areaMatch ? (
                      <span className="rounded-full bg-zk-warn-bg px-2 py-0.5 text-[11px] font-extrabold text-zk-warn-fg">Area match</span>
                    ) : null}
                    <span className="whitespace-nowrap text-xs text-zk-muted">
                      · <LocalTime compact date={bid.updatedAt} />
                    </span>
                  </p>
                  <p className="mb-0 mt-1 break-words text-[13px] leading-[1.5] text-zk-text">{bid.summary}</p>
                  <details className="group mt-1">
                    <summary className="cursor-pointer list-none text-xs font-bold text-zk-accent hover:underline [&::-webkit-details-marker]:hidden">
                      <span className="group-open:hidden">Show full description</span>
                      <span className="hidden group-open:inline">Hide full description</span>
                    </summary>
                    <p className="mb-0 mt-1.5 whitespace-pre-line break-words text-[13px] leading-[1.5] text-zk-text2">{bid.description}</p>
                  </details>
                  <EntryReplies replies={bid.replies} />
                  {canAward && open ? <AwardBidButton bidId={bid.id} /> : null}
                  {canReply ? <EntryReplyForm bugId={bugId} target={{ bidId: bid.id }} label="Reply to this bid" /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}
