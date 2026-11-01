"use client";

import { useOptimistic, useState, useTransition } from "react";
import { quickConfirmationAction } from "@/app/actions/confirmations";

type Verdict = "confirm" | "reject";

/**
 * Confirmations on an Open-tab row: confirms (up) and rejects (down), green
 * once confirmed. With no rejects only the confirms show, larger and centred;
 * hovering or focusing it shows both. While the issue requires confirmation a
 * person taps either one to confirm or reject it, with no text to write
 * (quickConfirmationAction). The count goes up at once and pops, with a +1
 * floating off it; the saved counts then replace it, or it goes back on an
 * error. Touch screens have no hover, so both always show.
 */
export function ConfirmationVoteBadge({ bugId, accepts, rejects, needed, confirmed, votable }: {
  bugId: string;
  accepts: number;
  rejects: number;
  needed: number;
  confirmed: boolean;
  /** The issue is at Requires confirmation, so a tap records an entry. */
  votable: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Which count to animate, and a key that restarts the animation on every tap.
  const [burst, setBurst] = useState<{ verdict: Verdict; key: number } | null>(null);
  const [counts, addVote] = useOptimistic({ accepts, rejects }, (current, verdict: Verdict) =>
    verdict === "confirm" ? { ...current, accepts: current.accepts + 1 } : { ...current, rejects: current.rejects + 1 },
  );

  const label = `${confirmed ? "Confirmed: " : ""}${counts.accepts} confirm${counts.accepts === 1 ? "" : "s"}, ${counts.rejects} reject${counts.rejects === 1 ? "" : "s"}; ${needed} needed`;
  // No rejects: the confirms alone, big, until hovered; touch screens always show both.
  const compact = counts.rejects === 0;
  const both = "group-hover:inline-flex group-focus-within:inline-flex [@media(hover:none)]:inline-flex";

  function vote(verdict: Verdict) {
    setError(null);
    setBurst((previous) => ({ verdict, key: (previous?.key ?? 0) + 1 }));
    startTransition(async () => {
      addVote(verdict);
      const result = await quickConfirmationAction(bugId, verdict);
      if (result.error) setError(result.error);
    });
  }

  const part = (verdict: Verdict, count: number, className: string, testId: string) => {
    const up = verdict === "confirm";
    const animated = burst?.verdict === verdict;
    const content = (
      <>
        <svg aria-hidden="true" viewBox="0 0 10 10" className="h-[0.7em] w-[0.7em]" fill="currentColor"><path d={up ? "M5 1.5 9 8H1z" : "M5 8.5 1 2h8z"} /></svg>
        <span key={animated ? burst.key : 0} className={`inline-block ${animated ? "motion-safe:animate-[zk-vote-pop_450ms_ease-out]" : ""}`}>{count}</span>
        {animated ? (
          <span
            key={`float-${burst.key}`}
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-0 opacity-0 text-[12px] font-bold motion-safe:animate-[zk-vote-float_700ms_ease-out_forwards]"
          >
            {up ? "+1" : "−1"}
          </span>
        ) : null}
      </>
    );
    const tone = up ? "text-zk-ok-fg" : "text-zk-bad-fg";
    if (!votable) return <span className={`items-center gap-0.5 ${tone} ${className}`} data-testid={testId}>{content}</span>;
    return (
      <button
        type="button"
        onClick={() => vote(verdict)}
        disabled={pending}
        aria-label={up ? "Confirm this issue" : "Reject this issue"}
        title={up ? "Confirm" : "Reject"}
        className={`relative items-center gap-0.5 rounded px-0.5 ${tone} hover:bg-zk-chip focus-visible:outline-2 focus-visible:outline-electric-blue disabled:cursor-wait ${className}`}
        data-testid={testId}
      >
        {content}
      </button>
    );
  };

  return (
    <span className="group relative inline-flex">
      <span
        data-testid="confirmation-count"
        data-tone={confirmed ? "ok" : "neutral"}
        role="group"
        aria-label={label}
        title={error ?? label}
        className={`inline-flex h-[42px] w-[42px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-[10px] border-[1.5px] font-mono font-semibold tabular-nums leading-none ${
          confirmed ? "border-transparent bg-zk-ok-bg text-zk-ok-fg" : "border-zk-border bg-zk-surface text-zk-text2"
        } ${error ? "border-zk-bad-fg" : ""}`}
      >
        {part("confirm", counts.accepts, compact ? `inline-flex text-[15px] group-hover:text-[11.5px] group-focus-within:text-[11.5px] [@media(hover:none)]:text-[11.5px]` : "inline-flex text-[11.5px]", "confirmation-accepts")}
        {part("reject", counts.rejects, compact ? `hidden text-[11.5px] ${both}` : "inline-flex text-[11.5px]", "confirmation-rejects")}
      </span>
    </span>
  );
}
