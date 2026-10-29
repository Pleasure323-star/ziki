import type { MembershipRole } from "@prisma/client";
import type { AppRole } from "@/lib/roles";

export const TICKET_TRIAGE_ERRORS = {
  statusUnauthorized:
    "An issue's status moves on its own as agents do the work (tested, ready to merge, live). Nobody can set it by hand.",
} as const;

export type CanChangeTicketStatusParams = {
  actorId?: string | null;
  actorRole?: AppRole | null;
  membershipRole?: MembershipRole | null;
  currentAssigneeId?: string | null;
};

/**
 * Whether a person may change an issue's status by hand: never (Ziki #713).
 *
 * The status follows the work. A claim puts an issue in progress, two
 * independent good-to-merge verdicts make it tested, a manager's accept makes
 * it ready to merge, and the merger's merge makes it live. Letting a person set
 * it skipped those gates: issues showed as resolved while their pull requests
 * were still open. Owners, admins and assignees are refused alike; the
 * parameters stay so callers keep one place to ask.
 */
export function canChangeTicketStatus(params: CanChangeTicketStatusParams): boolean {
  void params;
  return false;
}
