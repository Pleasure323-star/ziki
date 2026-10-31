"use client";

import { useState, useTransition } from "react";
import { addNoteCommentAction, voteNoteCommentAction } from "./actions";

/** The id the composer's text field has, for the Add note button to focus (#740). */
export const NOTE_COMPOSER_FIELD_ID = "note-comment-body";

/** A member writes a note comment (#732). An error keeps the draft. */
export function NoteCommentComposer({ projectId }: { projectId: string }) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState(false);
  const [pending, startTransition] = useTransition();
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!body.trim()) {
      setError("Write a note first.");
      return;
    }
    startTransition(async () => {
      const result = await addNoteCommentAction(projectId, body);
      if (result.error) {
        setError(result.error);
        return;
      }
      setBody("");
      setError(null);
      setPosted(true);
    });
  };
  return (
    <form onSubmit={submit} className="border-b border-zk-border px-5 py-4 sm:px-7" aria-label="Add a note">
      <label htmlFor={NOTE_COMPOSER_FIELD_ID} className="text-sm font-semibold text-zk-text">Add a note</label>
      <textarea
        id={NOTE_COMPOSER_FIELD_ID}
        value={body}
        onChange={(event) => { setBody(event.target.value); setPosted(false); }}
        rows={3}
        maxLength={10_000}
        placeholder="A discovery, a correction or a suggestion for this project. It doesn't change the official notes."
        className="mt-2 w-full rounded-lg border border-zk-border bg-zk-surface px-3 py-2 text-sm text-zk-text"
        aria-describedby={error ? "note-comment-error" : undefined}
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className="rounded-lg bg-electric-blue-strong px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
          {pending ? "Posting…" : "Post note"}
        </button>
        {error ? <p id="note-comment-error" role="alert" className="text-sm text-zk-bad-fg">{error}</p> : null}
        {posted && !error ? <p role="status" className="text-sm text-zk-ok-fg">Posted.</p> : null}
      </div>
    </form>
  );
}

/** Upvote a note comment, or take the upvote back (#732): one vote per person. */
export function NoteUpvoteButton({ projectId, commentId, upvotes, upvoted }: { projectId: string; commentId: string; upvotes: number; upvoted: boolean }) {
  const [state, setState] = useState({ upvotes, upvoted });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const toggle = () => {
    const next = !state.upvoted;
    const before = state;
    setState({ upvoted: next, upvotes: state.upvotes + (next ? 1 : -1) });
    startTransition(async () => {
      const result = await voteNoteCommentAction(projectId, commentId, next);
      if (result.error) {
        setState(before);
        setError(result.error);
        return;
      }
      setError(null);
      setState({ upvoted: result.upvoted ?? next, upvotes: result.upvotes ?? before.upvotes });
    });
  };
  return (
    <span className="mt-3 inline-flex items-center gap-2">
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-pressed={state.upvoted}
        aria-label={`${state.upvoted ? "Remove your upvote" : "Upvote"}; ${state.upvotes} ${state.upvotes === 1 ? "upvote" : "upvotes"}`}
        className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${state.upvoted ? "border-transparent bg-zk-ok-bg text-zk-ok-fg" : "border-zk-border text-zk-text2 hover:bg-zk-chip"}`}
      >
        ↑ {state.upvotes} {state.upvotes === 1 ? "upvote" : "upvotes"}
      </button>
      {error ? <span role="alert" className="text-xs text-zk-bad-fg">{error}</span> : null}
    </span>
  );
}

/**
 * The Notes page's Add note button (#740): it takes you to the note composer
 * with the cursor in its text field. Every member may add a note, so it always
 * shows; it doesn't edit the official notes.
 */
export function AddNoteButton() {
  const focusComposer = () => {
    const field = document.getElementById(NOTE_COMPOSER_FIELD_ID);
    if (!field) return;
    field.scrollIntoView({ behavior: "smooth", block: "center" });
    field.focus({ preventScroll: true });
  };
  return (
    <button type="button" onClick={focusComposer} className="rounded-lg bg-electric-blue-strong px-3 py-2 text-sm font-semibold text-white hover:brightness-110">
      Add note
    </button>
  );
}
