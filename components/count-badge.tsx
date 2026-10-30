import type { ReactNode } from "react";

export type CountBadgeTone = "neutral" | "ok" | "bad";

const TONE: Record<CountBadgeTone, string> = {
  neutral: "border-zk-border bg-zk-surface text-zk-text2",
  ok: "border-transparent bg-zk-ok-bg text-zk-ok-fg",
  bad: "border-transparent bg-zk-bad-bg text-zk-bad-fg",
};

/**
 * The one number box in a list row's first column (#count-badge): an idea's
 * score, an issue's importance, the confirmations on Requires confirmation.
 * Same size, border and type everywhere; green or red when the number means
 * something has been decided, with an optional icon under the number.
 */
export function CountBadge({
  value,
  label,
  tone = "neutral",
  icon,
  testId,
}: {
  value: number;
  /** Read out and shown on hover, e.g. "Importance 3". */
  label: string;
  tone?: CountBadgeTone;
  icon?: ReactNode;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      aria-label={label}
      title={label}
      className={`inline-flex h-[42px] w-[42px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-[10px] border-[1.5px] font-mono text-[13px] font-semibold tabular-nums leading-none ${TONE[tone]}`}
    >
      <span>{value}</span>
      {icon ? <span aria-hidden="true" className="flex">{icon}</span> : null}
    </span>
  );
}

/** The small check under a confirmed or accepted count. */
export function CountBadgeCheck() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}
