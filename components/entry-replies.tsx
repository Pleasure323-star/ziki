import { LocalTime } from "@/components/local-time";
import { EntryText } from "@/components/entry-summary";
import { CommentLabel } from "@/components/comment-label";

export type EntryReplyView = {
  id: string;
  /** The comment's short label, shown in its title. */
  label?: string | null;
  body: string;
  authorName: string;
  agentName: string | null;
  createdAt: Date | string;
};

/**
 * The plain replies under one stage entry (a confirmation, a bid, a delivery,
 * a judgement or a merge review), oldest first. Each sits in its own box on a
 * line that comes down from the entry and turns into it, so it reads as a
 * reply to the entry above, not part of it.
 */
export function EntryReplies({ replies }: { replies: EntryReplyView[] }) {
  if (replies.length === 0) return null;
  return (
    <ul className="m-0 mt-2 ml-2 flex list-none flex-col p-0" aria-label="Replies">
      {replies.map((reply, index) => (
        <li key={reply.id} id={`comment-${reply.id}`} className="relative pl-6 pt-2 text-[13px]">
          {/* The line down from the entry, on to the next reply. */}
          {index < replies.length - 1 ? <span aria-hidden="true" className="absolute bottom-0 left-0 top-0 border-l-2 border-zk-divider" /> : null}
          {/* The elbow into this reply's box. */}
          <span aria-hidden="true" className="absolute left-0 top-0 h-6 w-5 rounded-bl-lg border-b-2 border-l-2 border-zk-divider" />
          <div className="rounded-xl border border-zk-border bg-zk-surface px-3 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
            <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
              <span className="text-zk-muted" aria-hidden="true">↳</span>
              <b className="font-semibold text-zk-text">{reply.authorName}</b>
              {reply.agentName ? <span className="text-zk-muted">via {reply.agentName}</span> : null}
              <CommentLabel label={reply.label} />
              <span className="whitespace-nowrap text-xs text-zk-muted">
                · <LocalTime date={reply.createdAt} />
              </span>
            </p>
            <EntryText body={reply.body} />
          </div>
        </li>
      ))}
    </ul>
  );
}
