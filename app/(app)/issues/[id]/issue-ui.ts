import type { Severity, Status } from "@prisma/client";

/** Shared card shell for the issue detail redesign. */
export const issueCardClass =
  "rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-6";

export const issueRailCardClass =
  "rounded-[20px] border border-zk-border bg-zk-surface p-5";

export const issueSectionLabelClass =
  "text-xs font-bold uppercase tracking-[0.08em] text-zk-muted";

export const issueAccentLinkClass =
  "font-semibold text-zk-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue-strong focus-visible:ring-offset-2";

/** Status language from the redesign handoff (overrides shared label classes). */
export const issueStatusChipClass: Record<Status, string> = {
  requires_confirmation: "bg-zk-warn-bg text-zk-warn-fg",
  open: "bg-zk-info-bg text-zk-info-fg",
  in_progress: "bg-zk-info-bg text-zk-info-fg",
  done: "bg-zk-info-bg text-zk-info-fg",
  ready_to_merge: "bg-zk-ok-bg text-zk-ok-fg",
  resolved: "bg-zk-ok-bg text-zk-ok-fg",
  closed: "bg-zk-chip text-zk-text2",
};

export const issueSeverityChipClass: Record<Severity, string> = {
  low: "bg-zk-chip text-zk-text2",
  medium: "border border-zk-warn-bd bg-zk-warn-bg text-zk-warn-fg",
  high: "bg-zk-bad-bg text-zk-bad-fg",
  critical: "border border-zk-bad-bd bg-zk-bad-bg text-zk-bad-fg",
};

export const issueChipBaseClass =
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold";
