import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { AddConfirmationDialog } from "@/components/add-confirmation-dialog";
import { ConfirmationReplyForm } from "@/components/confirmation-reply-form";
import type { ConfirmationVerdictName } from "@/components/confirmation-form";
import { severityLabel } from "@/lib/labels";
import { issuePath } from "@/lib/issue-ref";

type SeverityName = keyof typeof severityLabel;

export type ConfirmationReplyView = {
  id: string;
  body: string;
  authorName: string;
  agentName: string | null;
  createdAt: Date | string;
};

export type ConfirmationEntryView = {
  id: string;
  verdict: ConfirmationVerdictName;
  summary: string;
  description: string;
  severity: SeverityName | null;
  duplicateOf: { id: string; number: number } | null;
  onBehalfOfUserId: string;
  by: string;
  agentName: string | null;
  counted: boolean;
  undone: boolean;
  updatedAt: Date | string;
  replies: ConfirmationReplyView[];
};

export type ConfirmationsData = {
  confirmations: number;
  confirmationsNeeded: number;
  entries: ConfirmationEntryView[];
};

/** Why the viewer can't give an entry, or null when they can. */
export type ConfirmationBlock = "own" | "deleted" | null;

const BLOCK_REASON: Record<Exclude<ConfirmationBlock, null>, string> = {
  own: "This is your own issue, so you can't confirm it.",
  deleted: "This issue is deleted.",
};

export const confirmationVerdictLabels: Record<ConfirmationVerdictName, string> = {
  confirm: "Confirm",
  reject: "Reject",
  neutral: "Neutral",
};

const verdictChipClass: Record<ConfirmationVerdictName, string> = {
  confirm: "bg-zk-ok-bg text-zk-ok-fg",
  reject: "bg-zk-bad-bg text-zk-bad-fg",
  neutral: "bg-zk-chip text-zk-text2",
};

/** "1 of 2 confirmations". */
export function confirmationsText(confirmations: number, needed: number): string {
  return `${confirmations} of ${needed} confirmation${needed === 1 ? "" : "s"}`;
}

/**
 * The Requires confirmation stage (#issue-confirmations), in place of the
 * conversation's "Add comment": each person's entry — confirm, neutral or
 * reject — with its summary, its full description behind a toggle, and its
 * replies. "Add confirmation" opens the form.
 */
export function IssueConfirmationsPanel({
  bugId,
  data,
  viewerId,
  block,
  summaryMaxChars,
}: {
  bugId: string;
  data: ConfirmationsData;
  viewerId: string | null;
  block: ConfirmationBlock;
  summaryMaxChars: number;
}) {
  const reached = data.confirmations >= data.confirmationsNeeded;
  const mine = viewerId ? data.entries.find((entry) => entry.onBehalfOfUserId === viewerId) ?? null : null;

  return (
    <section id="confirmations" aria-labelledby="confirmations-heading" className="mb-4 scroll-mt-24">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 id="confirmations-heading" className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
          Confirmations
          <span className="font-mono font-normal normal-case tracking-normal">{data.entries.length}</span>
        </h3>
        <div className="flex items-center gap-2">
          <span
            data-testid="confirmation-count"
            aria-label="Confirmations"
            className={`rounded-full px-2.5 py-0.5 text-xs font-bold tabular-nums ${reached ? "bg-zk-ok-bg text-zk-ok-fg" : "bg-zk-tint text-zk-accent"}`}
          >
            {confirmationsText(data.confirmations, data.confirmationsNeeded)}
          </span>
          {block || !viewerId ? null : (
            <AddConfirmationDialog
              bugId={bugId}
              summaryMaxChars={summaryMaxChars}
              mine={
                mine
                  ? {
                      verdict: mine.verdict,
                      summary: mine.summary,
                      description: mine.description,
                      severity: mine.severity,
                      duplicateOfNumber: mine.duplicateOf?.number ?? null,
                    }
                  : null
              }
            />
          )}
        </div>
      </div>
      <p className="mb-3 text-[13px] text-zk-text2">
        Confirm if it is real and not a duplicate; reject if it is not, or name the issue it duplicates. It is confirmed once{" "}
        {data.confirmationsNeeded} independent {data.confirmationsNeeded === 1 ? "person confirms" : "people confirm"} it.
      </p>
      {block ? (
        <p className="mb-3 text-[13px] text-zk-muted" data-testid="confirmation-blocked">
          {BLOCK_REASON[block]}
        </p>
      ) : null}

      {data.entries.length === 0 ? (
        <p className="m-0 text-[13px] text-zk-muted">No confirmations yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {data.entries.map((entry) => (
            <li key={entry.id} id={`confirmation-${entry.id}`} className="rounded-xl border border-zk-divider px-3 py-2.5">
              <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${verdictChipClass[entry.verdict]}`}>
                  {confirmationVerdictLabels[entry.verdict]}
                </span>
                <b className="font-semibold text-zk-text">{entry.by}</b>
                {entry.agentName ? <span className="text-zk-muted">via {entry.agentName}</span> : null}
                {entry.verdict === "confirm" && entry.severity ? (
                  <span className="text-zk-muted">· severity {severityLabel[entry.severity]}</span>
                ) : null}
                {entry.duplicateOf ? (
                  <span className="text-zk-muted">
                    · duplicate of{" "}
                    <Link href={issuePath(entry.duplicateOf.number)} className="font-bold text-zk-accent hover:underline">
                      #{entry.duplicateOf.number}
                    </Link>
                  </span>
                ) : null}
                <span className="whitespace-nowrap text-xs text-zk-muted">
                  · <LocalTime compact date={entry.updatedAt} />
                </span>
              </p>
              <p className="mb-0 mt-1 break-words text-[13px] leading-[1.5] text-zk-text">{entry.summary}</p>
              {entry.verdict !== "neutral" && !entry.counted ? (
                <p className="mb-0 mt-1 text-xs text-zk-muted" data-testid="confirmation-not-counted">
                  {entry.undone
                    ? "Undone by a workspace admin, so it doesn't count."
                    : "Doesn't count: given before the latest edit, or not independent of this issue."}
                </p>
              ) : null}
              <details className="group mt-1">
                <summary className="cursor-pointer list-none text-xs font-bold text-zk-accent hover:underline [&::-webkit-details-marker]:hidden">
                  <span className="group-open:hidden">Show full description</span>
                  <span className="hidden group-open:inline">Hide full description</span>
                </summary>
                <p className="mb-0 mt-1.5 whitespace-pre-line break-words text-[13px] leading-[1.5] text-zk-text2">{entry.description}</p>
              </details>
              {entry.replies.length > 0 ? (
                <ul className="m-0 mt-2 flex list-none flex-col gap-2 border-l-2 border-zk-divider p-0 pl-3" aria-label="Replies">
                  {entry.replies.map((reply) => (
                    <li key={reply.id} id={`comment-${reply.id}`} className="text-[13px]">
                      <p className="m-0 flex flex-wrap items-center gap-x-2 text-[12.5px]">
                        <b className="font-semibold text-zk-text">{reply.authorName}</b>
                        {reply.agentName ? <span className="text-zk-muted">via {reply.agentName}</span> : null}
                        <span className="whitespace-nowrap text-xs text-zk-muted">
                          · <LocalTime compact date={reply.createdAt} />
                        </span>
                      </p>
                      <p className="mb-0 mt-0.5 whitespace-pre-line break-words leading-[1.5] text-zk-text">{reply.body}</p>
                    </li>
                  ))}
                </ul>
              ) : null}
              {viewerId && block !== "deleted" ? <ConfirmationReplyForm bugId={bugId} confirmationId={entry.id} /> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
