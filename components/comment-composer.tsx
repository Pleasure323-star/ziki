"use client";

import { useId, useState, useTransition } from "react";
import { addCommentAction } from "@/app/actions/issues";

/**
 * A comment on the issue itself. Only an Open issue takes these
 * (lib/comment-placement.ts); every other stage takes its entries.
 */
export function CommentComposer({ bugId }: { bugId: string }) {
  const id = useId();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!body.trim()) return setError("Write a comment first.");
    const data = new FormData();
    data.set("body", body);
    startTransition(async () => {
      const result = await addCommentAction(bugId, data);
      if (result.error) {
        setError(result.error);
        return;
      }
      setBody("");
    });
  };

  return (
    <form onSubmit={onSubmit} aria-label="Add a comment" className="mb-4 flex flex-col gap-2 print:hidden">
      <label htmlFor={`${id}-comment`} className="sr-only">
        Comment
      </label>
      <textarea
        id={`${id}-comment`}
        name="body"
        rows={3}
        maxLength={2000}
        value={body}
        placeholder="Add a comment"
        onChange={(event) => setBody(event.target.value)}
        className="w-full rounded-xl border border-zk-border bg-zk-surface px-3 py-2 text-sm text-zk-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue-strong"
      />
      {error ? (
        <p role="alert" className="m-0 text-xs font-medium text-red-700">
          {error}
        </p>
      ) : null}
      <div>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-9 items-center rounded-full bg-electric-blue-strong px-4 text-[13px] font-bold text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Posting…" : "Comment"}
        </button>
      </div>
    </form>
  );
}
