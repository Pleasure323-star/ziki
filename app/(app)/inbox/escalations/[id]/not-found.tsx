import Link from "next/link";
import { StatusPage, primaryActionClass } from "@/components/status-page";

/** An escalation that doesn't exist or was addressed to someone else. */
export default function EscalationNotFound() {
  return (
    <StatusPage
      code="404"
      title="We couldn't find that escalation"
      actions={
        <Link href="/inbox?tab=escalations" className={primaryActionClass}>
          All escalations
        </Link>
      }
    >
      <p>The link may be wrong, or the escalation may have been sent to someone else.</p>
    </StatusPage>
  );
}
