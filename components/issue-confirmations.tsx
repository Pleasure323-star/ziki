import { EntrySummary } from "@/components/entry-summary";
import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { AddConfirmationDialog } from "@/components/add-confirmation-dialog";
import { EntryReplyForm } from "@/components/entry-reply-form";
import { EntryReplies, type EntryReplyView } from "@/components/entry-replies";
import type { ConfirmationVerdictName } from "@/components/confirmation-form";
import { severityLabel } from "@/lib/labels";
import { issuePath } from "@/lib/issue-ref";

type SeverityName = keyof typeof severityLabel;

export type ConfirmationReplyView = EntryReplyView;

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
 * Whether the issue is confirmed, at the top of its confirmations: the status
 * decides (an issue past Requires confirmation was confirmed); the people are
 * the confirms that count, the date the one that confirmed it.
 */
function ConfirmationBanner({ data, confirmed }: { data: ConfirmationsData; confirmed: boolean }) {
  const confirms = data.entries
    .filter((entry) => entry.verdict === "confirm" && entry.counted && !entry.undone)
    .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
  const deciding = confirms[Math.min(data.confirmationsNeeded, confirms.length) - 1] ?? null;
  if (confirmed) {
    return (
      <div data-testid="confirmation-banner" data-confirmed="true" className="mb-4 flex items-start gap-3 rounded-2xl border-2 border-zk-ok-fg/40 bg-zk-ok-bg px-4 py-3">
        <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zk-ok-fg text-white">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="m-0 text-[15px] font-extrabold text-zk-text">Confirmed</p>
          <p className="m-0 mt-0.5 text-[13px] text-zk-text2">
            {confirms.length > 0 ? (
              <>
                By {confirms.map((entry) => entry.by).join(", ")}
                {deciding ? (
                  <>
                    {" "}· <LocalTime compact date={deciding.updatedAt} />
                  </>
                ) : null}
              </>
            ) : (
              "Confirmed before confirmations were recorded as entries."
            )}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div data-testid="confirmation-banner" data-confirmed="false" className="mb-4 flex items-start gap-3 rounded-2xl border-2 border-zk-warn-fg/40 bg-zk-warn-bg px-4 py-3">
      <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zk-warn-fg text-white">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
          <path d="M12 7v6M12 17h.01" />
        </svg>
      </span>
      <div className="min-w-0">
        <p className="m-0 text-[15px] font-extrabold text-zk-text">Not confirmed yet</p>
        <p className="m-0 mt-0.5 text-[13px] text-zk-text2">
          {confirmationsText(data.confirmations, data.confirmationsNeeded)} from independent people.
        </p>
      </div>
    </div>
  );
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
  history = false,
  confirmed,
}: {
  bugId: string;
  data: ConfirmationsData;
  viewerId: string | null;
  block: ConfirmationBlock;
  summaryMaxChars: number;
  /** The read-only record once the issue is confirmed (#entry-replies-only): no new entries, no replies. */
  history?: boolean;
  /** The issue is past Requires confirmation (its status says so). */
  confirmed: boolean;
}) {
  const mine = viewerId ? data.entries.find((entry) => entry.onBehalfOfUserId === viewerId) ?? null : null;

  return (
    <section id="confirmations" aria-labelledby="confirmations-heading" className="mb-4 scroll-mt-24">
      <ConfirmationBanner data={data} confirmed={confirmed} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 id="confirmations-heading" className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
          Confirmations
          <span className="font-mono font-normal normal-case tracking-normal">{data.entries.length}</span>
        </h3>
        <div className="flex items-center gap-2">
          {history || block || !viewerId ? null : (
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
      {block && !history ? (
        <p className="mb-3 text-[13px] text-zk-muted" data-testid="confirmation-blocked">
          {BLOCK_REASON[block]}
        </p>
      ) : null}

      {data.entries.length === 0 ? (
        <p className="m-0 text-[13px] text-zk-muted">No confirmations yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {data.entries.map((entry) => (
            // A lighter shade of the banner's beige sets confirmations apart from comments.
            <li
              key={entry.id}
              id={`confirmation-${entry.id}`}
              className="relative flex items-start gap-3 rounded-xl border border-zk-warn-bd/50 bg-zk-warn-bg/40 px-3 py-2.5"
            >
              <span
                data-testid="confirmation-verdict"
                className={`flex w-[72px] shrink-0 items-center justify-center rounded-lg px-2 py-1.5 text-xs font-bold ${verdictChipClass[entry.verdict]}`}
              >
                {confirmationVerdictLabels[entry.verdict]}
              </span>
              <div className="min-w-0 flex-1">
              <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 pr-8 text-[13px]">
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
              <EntrySummary summary={entry.summary} description={entry.description} />
              {entry.verdict !== "neutral" && !entry.counted ? (
                <p className="mb-0 mt-1 text-xs text-zk-muted" data-testid="confirmation-not-counted">
                  {entry.undone
                    ? "Undone by a workspace admin, so it doesn't count."
                    : "Doesn't count: given before the latest edit, or not independent of this issue."}
                </p>
              ) : null}
              <EntryReplies replies={entry.replies} />
              {!history && viewerId && block !== "deleted" ? (
                <EntryReplyForm bugId={bugId} target={{ confirmationId: entry.id }} label="Reply to this confirmation" icon />
              ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
