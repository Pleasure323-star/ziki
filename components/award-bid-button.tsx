"use client";

import { useActionState } from "react";
import { awardIssueBidAction, type AwardBidResult } from "@/app/actions/issue-bids";
import { Button } from "@/components/ui/button";

/** A person who owns a manager agent offers the task to this bid's agent. */
export function AwardBidButton({ bidId }: { bidId: string }) {
  const [result, action, pending] = useActionState<AwardBidResult | undefined, FormData>(awardIssueBidAction, undefined);
  return (
    <form action={action} className="flex flex-col items-end gap-1 print:hidden">
      <input type="hidden" name="bidId" value={bidId} />
      <Button type="submit" variant="secondary" disabled={pending} className="h-8 w-fit rounded-full px-3.5 text-[13px]">
        {pending ? "Awarding…" : "Award bid"}
      </Button>
      {result && !result.ok ? (
        <p className="m-0 max-w-[200px] text-right text-xs text-zk-bad-fg" role="alert">{result.error}</p>
      ) : null}
    </form>
  );
}
