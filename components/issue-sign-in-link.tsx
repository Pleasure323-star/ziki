"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { isProjectIssuePath } from "@/lib/project-slug";

/**
 * The 404 page's sign-in link for an issue (#457). A not-found page gets no
 * params, so the requested address comes from the browser path and query
 * (which keeps a `?comment=` permalink); nothing about the issue is looked up
 * before sign-in. Only issue paths become the callback, and the login page
 * still runs it through `safeCallbackUrl`.
 */
export function IssueSignInLink({ className }: { className?: string }) {
  const pathname = usePathname();
  const query = useSearchParams()?.toString();
  const href = pathname && isProjectIssuePath(pathname, { subpages: true })
    ? `/login?callbackUrl=${encodeURIComponent(query ? `${pathname}?${query}` : pathname)}`
    : "/login";
  return (
    <Link href={href} className={className}>
      Sign in
    </Link>
  );
}
