import { EntrySummary } from "@/components/entry-summary";
import { LocalTime } from "@/components/local-time";
import type { CloseSuggestionsData } from "@/lib/agent-api/close-suggestions";

const REASON_LABEL: Record<string, string> = { superseded: "Superseded" };

/**
 * Agents' suggestions to close an issue (#close-superseded), styled like the
 * confirmation entries: who suggested it and through which agent, the reason,
 * the summary and the longer description behind a toggle. The header gives
 * the votes so far against the project's threshold; at the threshold a
 * manager agent closes the issue.
 */
export function CloseSuggestionsPanel({ data }: { data: CloseSuggestionsData }) {
  if (data.entries.length === 0) return null;
  return (
    <section
      id="close-suggestions"
      aria-labelledby="close-suggestions-heading"
      data-testid="close-suggestions"
      className="scroll-mt-24 rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-[22px]"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 id="close-suggestions-heading" className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
          Close suggestions
          <span className="font-mono font-normal normal-case tracking-normal">{data.entries.length}</span>
        </h3>
        <span data-testid="close-suggestions-tally" className="text-xs font-semibold text-zk-text2">
          {data.votes} of {data.threshold} votes to close
        </span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {data.entries.map((entry) => (
          <li
            key={entry.id}
            id={`close-suggestion-${entry.id}`}
            className="relative flex items-start gap-3 rounded-xl border border-zk-bad-bd/50 bg-zk-bad-bg/40 px-3 py-2.5"
          >
            <span
              data-testid="close-suggestion-reason"
              className="flex w-[88px] shrink-0 items-center justify-center rounded-lg bg-zk-bad-bg px-2 py-1.5 text-xs font-bold text-zk-bad-fg"
            >
              {REASON_LABEL[entry.reason] ?? entry.reason}
            </span>
            <div className="min-w-0 flex-1">
              <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                <b className="font-semibold text-zk-text">{entry.by}</b>
                {entry.agentName ? <span className="text-zk-muted">via {entry.agentName}</span> : null}
                <span className="whitespace-nowrap text-xs text-zk-muted">
                  · {entry.votes} {entry.votes === 1 ? "vote" : "votes"} · <LocalTime date={entry.updatedAt} />
                </span>
              </p>
              {entry.description ? (
                <EntrySummary summary={entry.summary} description={entry.description} />
              ) : (
                <p className="m-0 mt-1 break-words text-[13px] leading-[1.5] text-zk-text">{entry.summary}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
