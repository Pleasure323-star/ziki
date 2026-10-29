import type { IssueStage } from "@/lib/issue-stage";
import type { MergePath } from "@/lib/merge-history";
import { MergePathChips } from "@/components/merge-path";
import { ElapsedTime } from "@/components/elapsed-time";

const icon = "h-3 w-3 shrink-0";

function Svg({ children, className = icon }: { children: React.ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {children}
    </svg>
  );
}

const CheckIcon = ({ className }: { className?: string }) => <Svg className={className}><path d="m5 12 4.5 4.5L19 7" /></Svg>;
const BotIcon = () => <Svg><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4v4M9 14h.01M15 14h.01" /></Svg>;
const ClockIcon = () => <Svg className="h-2.5 w-2.5 shrink-0"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
/** A filled check in a circle: the idea has passed its threshold. */
const CheckCircleIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="shrink-0">
    <path fillRule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.7 7.7a1 1 0 0 0-1.4-1.4L10.5 13l-1.8-1.8a1 1 0 0 0-1.4 1.4l2.5 2.5a1 1 0 0 0 1.4 0l5.5-5.4Z" clipRule="evenodd" />
  </svg>
);

const BulbIcon = () => (
  <Svg>
    <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.3 1.1 2.2h5c0-.9.5-1.7 1.1-2.2A6 6 0 0 0 12 3Z" />
  </Svg>
);

/** A hammer that taps, in place of the word "working". Still under reduced motion. */
function HammeringIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`hammering ${icon}`}>
      <g className="hammering-head">
        <path d="m15 12-8.4 8.4a2.1 2.1 0 1 1-3-3L12 9" />
        <path d="M17.6 15 22 10.6M20.9 11.7 12.3 3.1a1 1 0 0 0-1.4 0L9.6 4.4a1 1 0 0 0 0 1.4l8.6 8.6a1 1 0 0 0 1.4 0l1.3-1.3a1 1 0 0 0 0-1.4Z" />
      </g>
    </svg>
  );
}
const BidIcon = () => <Svg><path d="m14 13-7.5 7.5a2.1 2.1 0 0 1-3-3L11 10M16 16l6-6M8 8l6-6M9 7l8 8M21 11l-8-8" /></Svg>;

export type IssueRowWork = {
  /** The person the work is for (the agent's owner), or the assignee. */
  person: string | null;
  /** When the active claim started; null when unknown. */
  since: Date | null;
};

/**
 * One line saying where an issue stands: Idea (with its score), Requires confirmation
 * (bots), Ready for bids, who is working on it and for how long, or Resolved / Closed.
 * Once its fix is merged, the dev → staging → main chips from merge history instead.
 */
export function IssueRowStatus({
  status,
  stage,
  botConfirmations,
  work,
  reviewStatus,
  mergePath,
}: {
  status: string;
  stage: IssueStage | undefined;
  botConfirmations: number;
  work: IssueRowWork | null;
  reviewStatus?: string | null;
  /** Where the merged fix has got to; null or absent before it merges. */
  mergePath?: MergePath | null;
}) {
  const finished = status === "resolved" || status === "closed";
  // Reopening keeps reviewStatus "merged", so only finished issues show the path.
  if (mergePath && finished) {
    return <MergePathChips path={mergePath} compact />;
  }
  if (finished) {
    return (
      <span className={`issue-row-status inline-flex items-center gap-1 ${status === "resolved" ? "text-zk-ok-fg" : "text-zk-muted"}`}>
        <CheckIcon /> {status === "resolved" ? "Resolved" : "Closed"}
      </span>
    );
  }
  if (reviewStatus === "submitted") {
    return (
      <span className="issue-row-status inline-flex items-center gap-1.5 font-medium text-indigo-600 dark:text-indigo-400">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-500" />
        </span>
        PR Submitted
      </span>
    );
  }
  if (reviewStatus === "tested") {
    return (
      <span className="issue-row-status inline-flex items-center gap-1 font-medium text-sky-600 dark:text-sky-400">
        <CheckIcon /> Tested
      </span>
    );
  }
  if (reviewStatus === "ready_to_merge") {
    return (
      <span className="issue-row-status inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
        <CheckIcon /> Ready to Merge
      </span>
    );
  }
  if (reviewStatus === "rejected") {
    return (
      <span className="issue-row-status inline-flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400">
        <Svg><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></Svg> Needs Revision
      </span>
    );
  }
  if (reviewStatus === "merge_blocked" || reviewStatus === "merge_failed") {
    return (
      <span className="issue-row-status inline-flex items-center gap-1 font-medium text-rose-600 dark:text-rose-400">
        <Svg><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></Svg>{" "}
        {reviewStatus === "merge_blocked" ? "Merge Blocked" : "Merge Failed"}
      </span>
    );
  }
  if (work) {
    // Two lines: a working hammer and who, then how long.
    return (
      <span className="issue-row-status inline-flex min-w-0 flex-col items-start gap-0.5">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="text-zk-ok-fg"><HammeringIcon /></span>
          <span className="max-w-[9rem] truncate text-zk-text2">{work.person ?? "Someone"}</span>
          <span className="sr-only">is working on it</span>
        </span>
        {work.since ? (
          <span className="inline-flex items-center gap-0.5 pl-5 text-[10.5px] tabular-nums text-zk-muted">
            <ClockIcon />
            <ElapsedTime since={work.since} />
          </span>
        ) : null}
      </span>
    );
  }
  if (stage === "ready") {
    return (
      <span className="issue-row-status inline-flex items-center gap-1 text-zk-ok-fg">
        <BidIcon /> Ready for bids
      </span>
    );
  }
  if (stage === "confirming") {
    // An issue now; it is Ready for bids once independent bots confirm it.
    const bots = `${botConfirmations} ${botConfirmations === 1 ? "bot" : "bots"}`;
    return (
      <span
        className="issue-row-status inline-flex items-center gap-1 text-zk-text2"
        title={`Confirmed by ${bots} so far`}
      >
        <span className="text-zk-accent"><BotIcon /></span>
        <span>Requires confirmation…</span>
        <span className="sr-only"> Confirmed by {bots}.</span>
      </span>
    );
  }
  return <span className="issue-row-status inline-flex items-center gap-1 text-zk-text2">Open</span>;
}

/** An idea's row status (#idea-table): its score, and "Ready to convert" once it reaches the threshold. */
export function IdeaRowStatus({ score, threshold }: { score: number; threshold: number | null }) {
  const text = threshold === null ? `${score}` : `${score}/${threshold}`;
  // At the threshold a manager agent can convert it: say so plainly, in green.
  if (threshold !== null && score >= threshold) {
    return (
      <span
        className="issue-row-status inline-flex items-center gap-1 font-semibold text-zk-ok-fg"
        title={`Score ${score} of ${threshold}: a manager agent can convert it to an issue`}
      >
        <CheckCircleIcon /> Ready to convert{" "}
        <span className="tabular-nums font-normal">
          ({text})<span className="sr-only"> score</span>
        </span>
      </span>
    );
  }
  return (
    <span
      className="issue-row-status inline-flex items-center gap-1 text-zk-text2"
      title={`Score ${score}${threshold === null ? "" : ` of ${threshold}`}`}
    >
      <span className="text-amber-400"><BulbIcon /></span> Idea
      <span className="tabular-nums">
        ({text})<span className="sr-only"> score</span>
      </span>
    </span>
  );
}
