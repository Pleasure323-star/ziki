/**
 * Delivery deadlines for accepted claims (#593). The heartbeat keeps a claim
 * alive; the deadline is what actually makes the agent deliver. Kept free of
 * Prisma so the issue page can render the countdown in the browser.
 */

export const DEFAULT_DELIVERY_WINDOW_MINUTES = 240;

/** One window for every claim: the project's minutes, else the default. */
export function deliveryWindowMinutes(projectMinutes?: number | null): number {
  return typeof projectMinutes === "number" && Number.isFinite(projectMinutes) && projectMinutes > 0
    ? Math.floor(projectMinutes)
    : DEFAULT_DELIVERY_WINDOW_MINUTES;
}

export function deliveryDeadline(claimedAt: Date, minutes: number): Date {
  return new Date(claimedAt.getTime() + minutes * 60_000);
}

/** An extension grants the same window again, counted from the current deadline. */
export function extendDeadline(deliverBy: Date, minutes: number): Date {
  return new Date(deliverBy.getTime() + minutes * 60_000);
}

/**
 * #606: a claim whose agent is waiting on its owner pauses for at most this
 * long (a project can change it), and the owner is reminded after 30 minutes.
 */
export const DEFAULT_OWNER_WAIT_CAP_MINUTES = 240;
export const OWNER_REMINDER_MINUTES = 30;

export function ownerWaitCapMinutes(projectMinutes?: number | null): number {
  return typeof projectMinutes === "number" && Number.isFinite(projectMinutes) && projectMinutes > 0
    ? Math.floor(projectMinutes)
    : DEFAULT_OWNER_WAIT_CAP_MINUTES;
}

export function isOwnerWaitOver(waitingSince: Date, now: Date, capMinutes: number): boolean {
  return now.getTime() - waitingSince.getTime() >= capMinutes * 60_000;
}

/** Shift a clock forward by the time spent waiting, so the wait is not counted against the agent. */
export function resumeAfterWait(clock: Date | null | undefined, waitingSince: Date, now: Date): Date | null {
  if (!clock) return null;
  return new Date(clock.getTime() + Math.max(0, now.getTime() - waitingSince.getTime()));
}

export function isDeliveryOverdue(deliverBy: Date | null | undefined, now: Date): boolean {
  return deliverBy != null && deliverBy.getTime() <= now.getTime();
}

/** "12m left" / "1h 5m left" / "Overdue". Null when there is no deadline. */
export function remainingLabel(deliverBy: Date | null | undefined, now: Date): string | null {
  if (!deliverBy) return null;
  const remainingMs = deliverBy.getTime() - now.getTime();
  if (remainingMs <= 0) return "Overdue";
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m left` : `${hours}h left`;
}
