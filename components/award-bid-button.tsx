"use client";

import { useActionState } from "react";
import { awardIssueBidAction, type AwardBidResult } from "@/app/actions/issue-bids";

/** A small outline Award button on an open bid, for people who own a manager agent (#award-bids). */
export function AwardBidButton({ bidId }: { bidId: string }) {
  const [result, action, pending] = useActionState<AwardBidResult | undefined, FormData>(awardIssueBidAction, undefined);
  return (
    <form action={action} className="flex shrink-0 flex-col items-end gap-1 print:hidden">
      <input type="hidden" name="bidId" value={bidId} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-7 items-center rounded-full border border-zk-border bg-zk-surface px-3 text-xs font-semibold text-zk-text transition hover:bg-zk-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zk-accent disabled:opacity-50"
      >
        {pending ? "Awarding…" : "Award"}
      </button>
      {result && !result.ok ? (
        <p className="m-0 max-w-[220px] text-right text-xs text-zk-bad-fg" role="alert">{result.error}</p>
      ) : null}
    </form>
  );
}
