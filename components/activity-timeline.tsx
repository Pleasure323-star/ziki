import type { ActivityType } from "@prisma/client";
import { activityNote } from "@/lib/resolution-note";
import { LocalTime } from "@/components/local-time";
import { ExpandableText } from "@/components/expandable-text";

export type ActivityEntry = {
  id: string;
  type: ActivityType;
  summary: string;
  createdAt: Date;
  actor: { name: string };
  metadata?: unknown;
};

/** How many of the newest entries show before "Show earlier". */
const SHOWN = 2;

export function ActivityTimeline({
  activities,
  totalCount,
}: {
  /** The newest entries, oldest first. May be fewer than `totalCount`. */
  activities: ActivityEntry[];
  /** Every entry on the issue, so the heading does not under-report. */
  totalCount?: number;
}) {
  const total = totalCount ?? activities.length;
  // The newest SHOWN entries are always visible; the earlier ones show when
  // the toggle under them is ticked (CSS only, so it works without JavaScript).
  const earlier = activities.slice(0, Math.max(0, activities.length - SHOWN));
  const latest = activities.slice(earlier.length);
  const notLoaded = total - activities.length;
  return (
    <section className="group/activity rounded-[20px] border border-zk-border bg-zk-surface p-5">
      <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
        Activity ({total})
      </h2>
      {activities.length === 0 ? (
        <p className="mt-3 text-sm text-zk-muted">No activity recorded yet.</p>
      ) : (
        <>
          {earlier.length > 0 ? (
            <ActivityList entries={earlier} className="mt-3 hidden pb-3 group-has-checked/activity:block" />
          ) : null}
          <ActivityList entries={latest} className={earlier.length > 0 ? "group-has-checked/activity:mt-0 mt-3" : "mt-3"} />
          {earlier.length > 0 ? (
            <label className="mt-3 inline-flex cursor-pointer select-none text-[11px] text-zk-muted hover:text-zk-text2 hover:underline has-focus-visible:ring-2 has-focus-visible:ring-electric-blue-strong">
              <input type="checkbox" className="sr-only" />
              <span className="group-has-checked/activity:hidden">
                Show {earlier.length} earlier
                {notLoaded > 0 ? ` (of ${earlier.length + notLoaded})` : ""}
              </span>
              <span className="hidden group-has-checked/activity:inline">Hide earlier</span>
            </label>
          ) : null}
        </>
      )}
    </section>
  );
}

function ActivityList({ entries, className }: { entries: ActivityEntry[]; className: string }) {
  return (
    <ol className={`relative space-y-0 border-l border-zk-divider pl-4 sm:pl-5 ${className}`}>
      {entries.map((entry) => (
        <li key={entry.id} className="relative pb-3 last:pb-0">
          <span
            aria-hidden
            className="absolute -left-[1.15rem] sm:-left-[1.4rem] top-1 h-2 w-2 rounded-full border-2 border-zk-surface bg-electric-blue-strong"
          />
          {/* One line: who did what, the time on the right. */}
          <div className="flex min-w-0 items-baseline gap-3 text-xs text-zk-text2">
            <p className="m-0 min-w-0 flex-1 truncate" title={`${entry.actor.name} ${entry.summary}`}>
              <span className="font-bold text-zk-text">{entry.actor.name}</span> {entry.summary}
            </p>
            <LocalTime className="shrink-0 text-[11px] text-zk-muted" date={entry.createdAt} />
          </div>
          {entry.type === "status_changed" && activityNote(entry.metadata) ? (
            <ExpandableText maxLines={3} expandText="View more" collapseText="View less">
              <blockquote className="mt-1 whitespace-pre-wrap break-words border-l-[3px] border-zk-ok-fg/40 bg-zk-chip pl-3 text-xs text-zk-text2">
                {activityNote(entry.metadata)}
              </blockquote>
            </ExpandableText>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
