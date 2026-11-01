import type { Status } from "@prisma/client";
import { STATUS_OF } from "@/lib/issue-substatus";

/**
 * Resolution notes (#316): the human sentence that says what happened when
 * an issue was resolved or closed.
 *
 * The note lives on the status-change activity row (its `metadata.note`),
 * not on the issue. That is what makes "reopening keeps it in the history":
 * the activity row is never edited, so the note stays in the timeline for
 * good, while the banner at the top of the issue is derived from the
 * latest status change and so disappears on its own when the issue is
 * reopened.
 */

export const RESOLUTION_NOTE_MAX = 500;

const FINISHED: readonly Status[] = ["resolved", "closed"];

export function isFinishedStatus(status: Status | string | null | undefined): boolean {
  return !!status && (FINISHED as readonly string[]).includes(status);
}

export type ParsedNote = { note: string | null } | { error: string };

// Control characters other than tab and newline. Same family as display
// names: they can't be seen, so they have no business in a sentence.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g;

/**
 * Cleans the note typed into the form and decides whether it applies.
 * Only a change *into* resolved or closed can carry one: a note sent with
 * any other change is dropped rather than rejected, so a stale field in the
 * request can't fail an otherwise valid save.
 */
export function parseResolutionNote(
  raw: unknown,
  change: { from: Status; to: Status | undefined },
): ParsedNote {
  if (!change.to || change.to === change.from || !isFinishedStatus(change.to)) {
    return { note: null };
  }
  if (typeof raw !== "string") return { note: null };
  const note = raw
    .replace(CONTROL, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (note.length === 0) return { note: null };
  if ([...note].length > RESOLUTION_NOTE_MAX) {
    return { error: `Keep the resolution note to ${RESOLUTION_NOTE_MAX} characters or fewer.` };
  }
  return { note };
}

export type StatusChangeActivity = {
  createdAt: Date;
  metadata: unknown;
  actor: { name: string };
};

export type Resolution = { note: string; by: string; at: Date; status: Status };

function readMetadata(metadata: unknown): { to?: string; note?: string } {
  if (!metadata || typeof metadata !== "object") return {};
  const m = metadata as Record<string, unknown>;
  return {
    to: typeof m.to === "string" ? m.to : undefined,
    note: typeof m.note === "string" && m.note.trim() ? m.note : undefined,
  };
}

/**
 * The note to show at the top of the issue: the one attached to the status
 * change that put it in its current state. Anything older, or a note from
 * before a reopen, is history, not the current resolution.
 *
 * @param latest the most recent status-change activity, or null
 */
export function currentResolution(
  currentStatus: Status,
  latest: StatusChangeActivity | null,
): Resolution | null {
  if (!latest || !isFinishedStatus(currentStatus)) return null;
  const { to, note } = readMetadata(latest.metadata);
  // `to` is a substatus (#substatus), or a main status on older entries.
  if (!note || (to !== currentStatus && (STATUS_OF as Record<string, string>)[to ?? ""] !== currentStatus)) return null;
  return { note, by: latest.actor.name, at: latest.createdAt, status: currentStatus };
}

/** The note on any activity entry, for the timeline. */
export function activityNote(metadata: unknown): string | null {
  return readMetadata(metadata).note ?? null;
}
