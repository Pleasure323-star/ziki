import type { Severity, Status } from "@prisma/client";

export const severityLabel: Record<Severity, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export const statusLabel: Record<Status, string> = {
  requires_confirmation: "Requires confirmation",
  open: "Open",
  in_progress: "In progress",
  delivered: "Delivered",
  done: "Done",
  ready_to_merge: "Ready to merge",
  resolved: "Live",
  closed: "Closed",
};

export const severityLabels = severityLabel;
export const statusLabels = statusLabel;

export const severityClass: Record<Severity, string> = {
  low: "bg-slate-100 text-slate-800",
  medium: "bg-amber-100 text-amber-950",
  high: "bg-orange-100 text-orange-950",
  critical: "bg-red-100 text-red-950",
};

export const statusClass: Record<Status, string> = {
  requires_confirmation: "bg-amber-100 text-amber-950",
  open: "bg-sky-100 text-sky-950",
  in_progress: "bg-violet-100 text-violet-950",
  delivered: "bg-purple-100 text-purple-950",
  done: "bg-indigo-100 text-indigo-950",
  ready_to_merge: "bg-teal-100 text-teal-950",
  resolved: "bg-emerald-100 text-emerald-950",
  closed: "bg-zinc-100 text-zinc-800",
};

/** Marks the bug's reporter wherever their name appears on the bug page. */
export const authorBadgeClass = "bg-teal-100 text-teal-950";

/** Platform category badge style (#366). */
export const categoryBadgeClass = "border border-teal-200 bg-teal-50 text-teal-950";
