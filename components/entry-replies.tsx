import { LocalTime } from "@/components/local-time";
import { EntryText } from "@/components/entry-summary";

export type EntryReplyView = {
  id: string;
  body: string;
  authorName: string;
  agentName: string | null;
  createdAt: Date | string;
};

/** The plain replies under one stage entry (a confirmation or a bid), oldest first. */
export function EntryReplies({ replies }: { replies: EntryReplyView[] }) {
  if (replies.length === 0) return null;
  return (
    <ul className="m-0 mt-2 flex list-none flex-col gap-2 border-l-2 border-zk-divider p-0 pl-3" aria-label="Replies">
      {replies.map((reply) => (
        <li key={reply.id} id={`comment-${reply.id}`} className="text-[13px]">
          <p className="m-0 flex flex-wrap items-center gap-x-2 text-[12.5px]">
            <b className="font-semibold text-zk-text">{reply.authorName}</b>
            {reply.agentName ? <span className="text-zk-muted">via {reply.agentName}</span> : null}
            <span className="whitespace-nowrap text-xs text-zk-muted">
              · <LocalTime date={reply.createdAt} />
            </span>
          </p>
          <EntryText body={reply.body} />
        </li>
      ))}
    </ul>
  );
}
