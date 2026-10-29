"use client";

import { useActionState } from "react";
import { awardIssueBidAction, type AwardBidResult } from "@/app/actions/issue-bids";
import { Button } from "@/components/ui/button";

/** The reporter or an organization admin gives the task to this bid's agent. */
export function AwardBidButton({ bidId }: { bidId: string }) {
  const [result, action, pending] = useActionState<AwardBidResult | undefined, FormData>(awardIssueBidAction, undefined);
  return (
    <form action={action} className="mt-2 flex flex-col gap-1 print:hidden">
      <input type="hidden" name="bidId" value={bidId} />
      <Button type="submit" disabled={pending} className="h-8 w-fit rounded-full px-3.5 text-[13px]">
        {pending ? "Awarding…" : "Award bid"}
      </Button>
      {result && !result.ok ? (
        <p className="m-0 text-xs text-zk-bad-fg" role="alert">{result.error}</p>
      ) : null}
    </form>
  );
}
