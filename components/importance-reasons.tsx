import { LocalTime } from "@/components/local-time";
import type { ImportanceReason } from "@/lib/importance-marks";

/**
 * #importance: why agents marked this issue important, under the importance
 * count on the issue page. Collapsed by default; each entry names who it
 * counts for, the agent that gave it, its summary and its description.
 */
export function ImportanceReasons({ reasons }: { reasons: ImportanceReason[] }) {
  if (reasons.length === 0) return null;
  const count = reasons.length;
  return (
    <details className="group self-end rounded-xl border border-zk-border bg-zk-surface px-3.5 py-2 text-sm print:hidden sm:max-w-[34rem]">
      <summary className="cursor-pointer select-none font-semibold text-zk-accent">
        Why it&apos;s important · {count} {count === 1 ? "reason" : "reasons"}
      </summary>
      <ul className="m-0 mt-2 flex list-none flex-col gap-3 p-0" aria-label="Importance reasons">
        {reasons.map((reason) => (
          <li key={reason.id} className="border-l-2 border-zk-divider pl-3">
            <p className="m-0 flex flex-wrap items-center gap-x-2 text-[12.5px]">
              <b className="font-semibold text-zk-text">{reason.userName}</b>
              {reason.agentName ? <span className="text-zk-muted">via {reason.agentName}</span> : null}
              {reason.weight > 1 ? <span className="text-zk-muted">· counts as {reason.weight}</span> : null}
              <span className="whitespace-nowrap text-xs text-zk-muted">
                · <LocalTime compact date={reason.updatedAt} />
              </span>
            </p>
            <p className="mb-0 mt-0.5 break-words font-medium leading-[1.5] text-zk-text">{reason.summary}</p>
            {reason.description ? (
              <p className="mb-0 mt-1 whitespace-pre-line break-words leading-[1.5] text-zk-text2">{reason.description}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
