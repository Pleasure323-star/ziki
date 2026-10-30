import type { ReactNode } from "react";
import { Avatar } from "@/components/avatar";
import { ShortTime } from "@/components/short-time";

export type RowPill = {
  name: string;
  className: string;
  content?: ReactNode;
};

interface IssueRowMetaProps {
  pills: RowPill[];
  meta: ReactNode;
}

export const MAX_VISIBLE_PILLS = 3;

export function IssueRowPills({ pills }: { pills: RowPill[] }) {
  const visible = pills.slice(0, MAX_VISIBLE_PILLS);
  const hidden = pills.slice(MAX_VISIBLE_PILLS);

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
      {visible.map((pill) => (
        <span
          key={pill.name}
          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-bold ${pill.className}`}
        >
          {pill.content ?? pill.name}
        </span>
      ))}
      {hidden.length > 0 ? (
        <span
          className="inline-flex items-center rounded-full border border-zk-border bg-zk-chip px-2 py-0.5 text-xs font-bold text-zk-muted"
          title={`Also: ${hidden.map((pill) => pill.name).join(", ")}`}
          aria-label={`${hidden.length} more: ${hidden.map((pill) => pill.name).join(", ")}`}
        >
          +{hidden.length}
        </span>
      ) : null}
    </div>
  );
}

export function IssueRowMeta({ pills, meta }: IssueRowMetaProps) {
  return (
    <div className="min-w-0 space-y-1">
      <IssueRowPills pills={pills} />
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 truncate text-xs text-zk-muted pt-0.5">
        {meta}
      </p>
    </div>
  );
}

export function MetaSeparator() {
  return <span aria-hidden="true">·</span>;
}

export function RowAssignee({ name, image }: { name: string; image?: string | null }) {
  return (
    <span className="inline-flex shrink-0" title={`Assigned to ${name}`}>
      <Avatar name={name} image={image} size="sm" />
      <span className="sr-only">Assigned to {name}</span>
    </span>
  );
}

export function RowAge({ date, sort }: { date: Date; sort: "newest" | "updated" }) {
  return <ShortTime date={date} label={sort === "newest" ? "Opened" : "Updated"} />;
}

export function statusPillClass(status: string): string {
  switch (status) {
    case "open":
    case "in_progress":
      return "bg-zk-info-bg text-zk-info-fg";
    case "resolved":
      return "bg-zk-ok-bg text-zk-ok-fg";
    default:
      return "bg-zk-chip text-zk-text2";
  }
}

export function stagePillClass(stage: string): string {
  switch (stage) {
    case "confirmed":
    case "ready":
      return "bg-zk-ok-bg text-zk-ok-fg";
    default:
      return "bg-zk-chip text-zk-text2";
  }
}
