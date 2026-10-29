import type { Severity, Status } from "@prisma/client";
import type { IssueStage } from "@/lib/issue-stage";

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
  open: "bg-zk-info-bg text-zk-info-fg",
  in_progress: "bg-zk-info-bg text-zk-info-fg",
  resolved: "bg-zk-ok-bg text-zk-ok-fg",
  closed: "bg-zk-chip text-zk-text2",
};

export const issueSeverityChipClass: Record<Severity, string> = {
  low: "bg-zk-chip text-zk-text2",
  medium: "border border-zk-warn-bd bg-zk-warn-bg text-zk-warn-fg",
  high: "bg-zk-bad-bg text-zk-bad-fg",
  critical: "border border-zk-bad-bd bg-zk-bad-bg text-zk-bad-fg",
};

export const issueStageChipClass: Record<IssueStage, string> = {
  confirming: "bg-zk-warn-bg text-zk-warn-fg",
  ready: "bg-zk-info-bg text-zk-info-fg",
};

export const reviewStatusLabels: Record<string, string> = {
  submitted: "In Review",
  tested: "Tested",
  ready_to_merge: "Ready to Merge",
  rejected: "Needs Revision",
  merge_blocked: "Merge Blocked",
  merge_failed: "Merge Failed",
  merged: "Merged",
};

/**
 * Plain palette classes only. `theme-dark.css` already mirrors every palette
 * colour for dark mode and follows the theme the person picked, so a `dark:`
 * variant here flips the colour a second time and, because Tailwind's `dark:`
 * follows the device instead of Ziki's theme, shows a dark chip on a light
 * page. Blocked and failed merges are red, merged is purple.
 */
export const reviewStatusChipClass: Record<string, string> = {
  submitted: "border border-indigo-200 bg-indigo-50 text-indigo-700",
  tested: "border border-sky-200 bg-sky-50 text-sky-700",
  ready_to_merge: "border border-emerald-200 bg-emerald-50 text-emerald-700",
  rejected: "border border-amber-200 bg-amber-50 text-amber-700",
  merge_blocked: "border border-rose-200 bg-rose-50 text-rose-700",
  merge_failed: "border border-rose-300 bg-rose-100 text-rose-800",
  merged: "border border-purple-200 bg-purple-50 text-purple-700",
};

export const issueChipBaseClass =
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold";
