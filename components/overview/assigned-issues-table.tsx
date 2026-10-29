import Link from "next/link";
import type { Severity, Status } from "@prisma/client";
import { OverviewVote } from "@/components/overview/overview-vote";
import { formatIssueNumber } from "@/lib/issue-number";
import { issuePath } from "@/lib/issue-ref";
import { formatShortAge } from "@/lib/format";
import { issueStageLabels, type IssueStage } from "@/lib/issue-stage";
import { severityLabel, statusLabels } from "@/lib/labels";

export type OverviewAssignedIssue = {
  id: string;
  number: number;
  title: string;
  severity: Severity;
  status: Status;
  voteCount: number;
  /** An idea's net verdict score; null once it is an issue (#idea-verdicts). */
  ideaScore?: number | null;
  userVoted: boolean;
  typeName: string | null;
  commentCount: number;
  createdAt: string;
  stage: IssueStage | null;
};

function priorityTone(severity: Severity): {
  bg: string;
  fg: string;
  bd: string;
  label: string;
} {
  if (severity === "high" || severity === "critical") {
    return {
      bg: "bg-zk-bad-bg",
      fg: "text-zk-bad-fg",
      bd: "border-zk-bad-bd",
      label: severity === "critical" ? "Critical" : "High",
    };
  }
  if (severity === "medium") {
    return {
      bg: "bg-zk-warn-bg",
      fg: "text-zk-warn-fg",
      bd: "border-zk-warn-bd",
      label: "Medium",
    };
  }
  return {
    bg: "bg-zk-chip",
    fg: "text-zk-text2",
    bd: "border-transparent",
    label: severityLabel[severity],
  };
}

function stageTone(stage: IssueStage | null): { bg: string; fg: string; label: string } | null {
  if (!stage) return null;
  if (stage === "confirming" || stage === "ready") {
    return { bg: "bg-zk-ok-bg", fg: "text-zk-ok-fg", label: issueStageLabels[stage] };
  }
  return { bg: "bg-zk-chip", fg: "text-zk-text2", label: issueStageLabels[stage] };
}

function typeIconPath(typeName: string | null): string {
  const name = (typeName ?? "").toLowerCase();
  if (name.includes("security")) {
    return "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z";
  }
  if (name.includes("design")) {
    return "M12 3 4 9v12h16V9l-8-6zM9 21v-6h6v6";
  }
  return "M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5";
}

export function AssignedIssuesTable({ issues }: { issues: OverviewAssignedIssue[] }) {
  const countLabel = issues.length === 1 ? "1 issue" : `${issues.length} issues`;

  return (
    <section
      aria-labelledby="assigned-issues-heading"
      className="flex flex-col gap-3.5 rounded-[20px] border border-zk-border bg-zk-surface p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2.5">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h2 id="assigned-issues-heading" className="text-lg font-bold text-zk-text">
            Issues assigned to me
          </h2>
          <span className="text-[13px] text-zk-muted">{countLabel} · sorted by importance</span>
        </div>
        <Link
          href="/issues?mine=assigned"
          className="inline-flex h-9 items-center rounded-full border border-zk-border bg-zk-surface px-3.5 text-[13px] font-bold text-zk-accent transition hover:bg-zk-tint"
        >
          View all issues
        </Link>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[860px]">
          <div
            className="flex items-center gap-4 rounded-full bg-zk-tint px-4 py-3.5 text-xs font-bold uppercase tracking-[0.05em] text-zk-accent"
            role="row"
          >
            <abbr className="w-[52px] no-underline" title="Importance">Imp.</abbr>
            <span className="min-w-0 flex-1">Issue</span>
            <span className="w-[92px]">Type</span>
            <span className="w-24">Priority</span>
            <span className="w-[76px]">Status</span>
            <span className="w-[104px]">Stage</span>
            <span className="w-[84px]">Reported</span>
          </div>

          {issues.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 px-4 py-12 text-center">
              <span className="font-bold text-zk-text">Nothing assigned to you</span>
              <span className="text-zk-muted">Issues assigned to you will show up here.</span>
            </div>
          ) : (
            <ul>
              {issues.map((issue, index) => {
                const priority = priorityTone(issue.severity);
                const stage = stageTone(issue.stage);
                const statusOpen =
                  issue.status === "open" || issue.status === "in_progress";
                return (
                  <li
                    key={issue.id}
                    className={`flex items-center gap-4 px-4 py-3.5 ${
                      index < issues.length - 1 ? "border-b border-zk-divider" : ""
                    }`}
                  >
                    {typeof issue.ideaScore === "number" ? (
                      // Ideas take verdicts, not importance marks.
                      <span
                        className="inline-flex h-9 w-[52px] shrink-0 flex-col items-center justify-center rounded-full border border-dashed border-zk-border text-zk-text"
                        aria-label={`Idea score ${issue.ideaScore}`}
                        title={`Idea score ${issue.ideaScore}`}
                      >
                        <span className="text-[13px] font-bold leading-none tabular-nums">{issue.ideaScore}</span>
                        <span className="text-[9.5px] leading-tight text-zk-muted">score</span>
                      </span>
                    ) : (
                      <OverviewVote
                        bugId={issue.id}
                        voteCount={issue.voteCount}
                        voted={issue.userVoted}
                      />
                    )}
                    <Link
                      href={issuePath(issue.number)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left text-zk-text"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zk-tint text-zk-accent">
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d={typeIconPath(issue.typeName)} />
                        </svg>
                      </span>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-sm font-semibold leading-snug">
                          {issue.title}
                        </span>
                        <span className="flex items-center gap-2 text-xs text-zk-muted">
                          <span>{formatIssueNumber(issue.number)}</span>
                          {issue.commentCount > 0 ? (
                            <span className="inline-flex items-center gap-1">
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                              </svg>
                              {issue.commentCount} comment
                              {issue.commentCount === 1 ? "" : "s"}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </Link>
                    <span className="w-[92px] shrink-0 text-[13px] text-zk-text2">
                      {issue.typeName ?? "—"}
                    </span>
                    <span className="w-24 shrink-0">
                      <span
                        className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-bold ${priority.bg} ${priority.fg} ${priority.bd}`}
                      >
                        {priority.label}
                      </span>
                    </span>
                    <span className="w-[76px] shrink-0">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold ${
                          statusOpen
                            ? "bg-zk-info-bg text-zk-info-fg"
                            : "bg-zk-chip text-zk-text2"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            statusOpen ? "bg-zk-info-fg" : "bg-zk-muted"
                          }`}
                          aria-hidden="true"
                        />
                        {statusLabels[issue.status]}
                      </span>
                    </span>
                    <span className="w-[104px] shrink-0">
                      {stage ? (
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold ${stage.bg} ${stage.fg}`}
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                          {stage.label}
                        </span>
                      ) : (
                        <span className="text-[13px] text-zk-muted">—</span>
                      )}
                    </span>
                    <span className="w-[84px] shrink-0 text-[13px] text-zk-text2">
                      {formatShortAge(issue.createdAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      <span className="text-[13px] text-zk-muted">Showing {countLabel}</span>
    </section>
  );
}
