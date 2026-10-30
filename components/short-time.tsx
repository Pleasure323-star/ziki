"use client";

import { useSyncExternalStore } from "react";
import { formatDate, formatTimeAgo } from "@/lib/format";
import { getClientTimeZone, getServerTimeZone } from "@/components/local-time";

const emptySubscribe = () => () => {};

/**
 * A short age ("3 hours ago", "Oct 12", see formatTimeAgo) for list rows (#1061). Hovering shows
 * the full date, and screen readers hear the full date with its label. The visible text depends on "now", so the client's render may differ
 * from the server's by a minute; that difference is expected.
 */
export function ShortTime({ date, label }: { date: Date | string; label: string }) {
  const isClient = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const timeZone = isClient ? getClientTimeZone() : getServerTimeZone();
  const full = formatDate(date, timeZone);
  const iso = date instanceof Date ? date.toISOString() : date;
  return (
    <time dateTime={iso} title={`${label} ${full}`} suppressHydrationWarning>
      <span aria-hidden="true" suppressHydrationWarning>
        {formatTimeAgo(date, new Date(), timeZone)}
      </span>
      <span className="sr-only">
        {label} {full}
      </span>
    </time>
  );
}
