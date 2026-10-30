"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, type MouseEvent } from "react";

/** Where the issue list was last open in this tab: its tab, filters and page. */
const LAST_LIST_KEY = "ziki:last-issue-list";

/** On the issue list: remember the URL, so an issue's back arrow returns to it. */
export function RememberIssueList() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  useEffect(() => {
    try {
      sessionStorage.setItem(LAST_LIST_KEY, search ? `${pathname}?${search}` : pathname);
    } catch {
      // Storage can be blocked; the back arrow then uses its fallback.
    }
  }, [pathname, search]);
  return null;
}

/**
 * The back arrow on an issue or idea page: back to the list you came from,
 * on the same tab and filters; otherwise to `fallback` (the list for the
 * item's own status).
 */
export function BackToList({ fallback, label }: { fallback: string; label: string }) {
  const router = useRouter();
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    let last: string | null = null;
    try {
      last = sessionStorage.getItem(LAST_LIST_KEY);
    } catch {
      last = null;
    }
    if (!last || !last.startsWith("/")) return;
    event.preventDefault();
    router.push(last);
  };
  return (
    <Link
      href={fallback}
      onClick={onClick}
      aria-label={label}
      title={label}
      className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zk-accent hover:bg-zk-chip print:hidden"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M19 12H5M12 19l-7-7 7-7" />
      </svg>
    </Link>
  );
}
