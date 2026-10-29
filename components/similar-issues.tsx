"use client";

import { useEffect, useState } from "react";
import { statusLabels } from "@/lib/labels";
import { formatIssueNumber } from "@/lib/issue-number";
import { normalizeQuery, shouldSearch, type SimilarIssue } from "@/lib/similar-issues";
import { issuePath } from "@/lib/issue-ref";

/** Short enough to feel instant, long enough not to query every keystroke. */
const DEBOUNCE_MS = 200;

/**
 * Up to three open issues whose titles look like the one being typed
 * (#284). Purely advisory: it never blocks submitting, and failures are
 * silent because the report matters more than the hint.
 */
export function SimilarIssues({ title, id }: { title: string; id?: string }) {
  const query = normalizeQuery(title);
  const searchable = shouldSearch(query);
  const [result, setResult] = useState<{ query: string; issues: SimilarIssue[] } | null>(null);

  useEffect(() => {
    if (!searchable) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/issues/similar?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const body = (await res.json()) as { issues?: SimilarIssue[] };
        setResult({ query, issues: body.issues ?? [] });
      } catch {
        // Aborted by the next keystroke, or offline: show nothing.
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, searchable]);

  // Only results for what is in the box now; stale ones would mislead.
  const issues = searchable && result?.query === query ? result.issues : [];

  return (
    <div id={id} aria-live="polite" className="empty:hidden">
      {issues.length > 0 ? (
        <div className="mt-2 rounded-lg border border-zk-warn-bd bg-zk-warn-bg p-3">
          <p className="text-xs font-medium text-zk-warn-fg">
            Is it one of these? Voting on an existing issue helps more than a duplicate.
          </p>
          <ul className="mt-2 space-y-1.5">
            {issues.map((issue) => (
              <li key={issue.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <a
                  href={issuePath(issue.number)}
                  target="_blank"
                  rel="noopener"
                  className="min-w-0 break-words font-medium text-zk-accent hover:underline"
                >
                  <span className="font-normal text-zk-muted tabular-nums">
                    {formatIssueNumber(issue.number)}
                  </span>{" "}
                  {issue.title}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                <span className="text-xs text-zk-text2">
                  {statusLabels[issue.status]} ·{" "}
                  {issue.kind === "idea" ? `score ${issue.voteCount}` : `importance ${issue.voteCount}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
