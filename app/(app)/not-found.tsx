import Link from "next/link";
import { StatusPage, primaryActionClass } from "@/components/status-page";

/**
 * Shown when a signed-in page calls notFound() and its segment has no
 * not-found.tsx of its own (#214). Pages for one kind of thing (issues,
 * people, projects, agents, redesigns, escalations) name it in their own
 * not-found.tsx; this one stays general so it never names the wrong thing.
 */
export default function AppNotFound() {
  return (
    <StatusPage
      code="404"
      title="We couldn't find that page"
      actions={
        <Link href="/dashboard" className={primaryActionClass}>
          Go to issues
        </Link>
      }
    >
      <p>The link may be wrong, or what it pointed to may have been moved or deleted.</p>
    </StatusPage>
  );
}
