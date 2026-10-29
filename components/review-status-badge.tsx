import {
  reviewStatusLabels,
  reviewStatusChipClass,
  issueChipBaseClass,
} from "@/app/(app)/issues/[id]/issue-ui";

export type ReviewStatus = "submitted" | "tested" | "ready_to_merge" | "rejected" | "merge_blocked" | "merge_failed" | "merged" | string;

export function ReviewStatusBadge({
  status,
  className = "",
}: {
  status: ReviewStatus | null | undefined;
  className?: string;
}) {
  if (!status || !(status in reviewStatusLabels)) return null;

  const label = reviewStatusLabels[status] ?? status;
  const chipClass = reviewStatusChipClass[status] ?? "bg-zk-chip text-zk-text2";

  return (
    <span
      className={`${issueChipBaseClass} ${chipClass} ${className}`}
      data-testid="review-status-badge"
    >
      {status === "submitted" && (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-500" />
        </span>
      )}
      {status === "ready_to_merge" && (
        <svg
          className="h-3 w-3 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M16 17l5-5-5-5M19.8 12H9M10 3H6a2 2 0 00-2 2v14a2 2 0 002 2h4" />
        </svg>
      )}
      {(status === "rejected" || status === "merge_blocked" || status === "merge_failed") && (
        <svg
          className="h-3 w-3 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      )}
      {(status === "merged" || status === "tested") && (
        <svg
          className="h-3 w-3 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      )}
      <span>{label}</span>
    </span>
  );
}
