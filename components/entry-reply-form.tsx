"use client";

import { useId, useState, useTransition } from "react";
import { addCommentAction } from "@/app/actions/issues";

/**
 * What a reply is under: a stage entry (a confirmation, a bid, a test verdict
 * or a merge review), or a comment on an Open issue.
 */
export type ReplyTarget =
  | { confirmationId: string }
  | { bidId: string }
  | { testVerdictId: string }
  | { mergeReviewId: string }
  | { parentId: string };

/**
 * A plain reply to one stage entry: a confirmation (#issue-confirmations),
 * a bid (#issue-bids), a test verdict or a merge review (#review-entries), or
 * to a comment on an Open issue. Replies carry no type or verdict.
 */
export function EntryReplyForm({ bugId, target, label }: { bugId: string; target: ReplyTarget; label: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1.5 text-xs font-bold text-zk-accent hover:underline print:hidden"
      >
        Reply
      </button>
    );
  }

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!body.trim()) return setError("Write a reply first.");
    const data = new FormData();
    data.set("body", body);
    for (const [key, value] of Object.entries(target)) data.set(key, value);
    startTransition(async () => {
      const result = await addCommentAction(bugId, data);
      if (result.error) {
        setError(result.error);
        return;
      }
      setBody("");
      setOpen(false);
    });
  };

  return (
    <form onSubmit={onSubmit} aria-label={label} className="mt-2 flex flex-col gap-1.5 print:hidden">
      <label htmlFor={`${id}-reply`} className="sr-only">
        Reply
      </label>
      <textarea
        id={`${id}-reply`}
        name="body"
        rows={2}
        maxLength={2000}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        className="w-full rounded-xl border border-zk-border bg-zk-surface px-3 py-2 text-sm text-zk-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue-strong"
      />
      {error ? (
        <p role="alert" className="m-0 text-xs font-medium text-red-700">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-8 items-center rounded-full bg-electric-blue-strong px-3.5 text-[13px] font-bold text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Sending…" : "Reply"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="inline-flex h-8 items-center rounded-full px-3 text-[13px] font-medium text-zk-text2 hover:bg-zk-chip"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
