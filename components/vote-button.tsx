"use client";

import { useState, useTransition } from "react";
import { toggleVoteAction } from "@/app/actions/issues";
import type { VoterInfo } from "@/lib/voters";
import { VoterAvatars } from "@/components/voter-avatars";

/**
 * #importance: one "Mark important" control (once an upvote, #1059). It says
 * "this matters" and gates nothing. Only issues take it: an idea takes
 * verdicts (#idea-verdicts). A person's click is a plain toggle; an agent
 * marking it must give a reason, shown under the count on the issue page.
 */
type VoteButtonProps = {
  bugId: string;
  voteCount: number;
  userVote?: number;
  voted?: boolean;
  /** The importance count. Falls back to `voteCount`. */
  likeCount?: number;
  likeVoters?: VoterInfo[];
  size?: "sm" | "md";
  showAvatars?: boolean;
  /** Deleted issues: show the count, but it can't be changed. */
  readOnly?: boolean;
  /** Reference-style compact vote control, used only by the Issues list. */
  chevron?: boolean;
};

function ThumbsUp({ filled, className = "h-4 w-4" }: { filled: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? "0" : "2"}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {filled ? (
        <path d="M2 20h3a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1Zm19.38-9.3a2 2 0 0 0-1.68-.7H15V6a3 3 0 0 0-3-3c-1.38 0-2 1-2 2.5V9l-3.3 4.2A2 2 0 0 0 6 14.5V19a2 2 0 0 0 2 2h8.5a2 2 0 0 0 1.96-1.6l1.62-7.5a2 2 0 0 0-.7-1.2Z" />
      ) : (
        <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
      )}
    </svg>
  );
}

function AlertIcon({ className = "h-3.5 w-3.5 shrink-0" }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 5Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function VoteButton({
  bugId,
  voteCount,
  userVote,
  voted,
  likeCount: initialLikeCount,
  likeVoters = [],
  size = "sm",
  showAvatars = false,
  readOnly = false,
  chevron = false,
}: VoteButtonProps) {
  const initialVote = typeof userVote === "number" ? userVote : voted ? 1 : 0;
  const [upvoted, setUpvoted] = useState(initialVote === 1);
  const [count, setCount] = useState(Math.max(0, initialLikeCount ?? voteCount));
  const [error, setError] = useState<string | null>(null);
  const errorId = `vote-error-${bugId}`;
  const [pending, startTransition] = useTransition();
  const isMd = size === "md";

  const handleVote = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setError(null);

    const prev = { upvoted, count };
    setUpvoted(!upvoted);
    setCount(upvoted ? Math.max(0, count - 1) : count + 1);

    startTransition(async () => {
      const result = await toggleVoteAction(bugId, 1);
      if (result.error) {
        setError(result.error);
        setUpvoted(prev.upvoted);
        setCount(prev.count);
        return;
      }
      if (typeof result.likeCount === "number") setCount(result.likeCount);
      if (typeof result.userVote === "number") setUpvoted(result.userVote === 1);
      else if (typeof result.voted === "boolean") setUpvoted(result.voted);
    });
  };

  // WCAG 2.5.3: the accessible name has to contain the visible text in
  // order. The large control shows "Mark important 2", so its name starts
  // with that phrase; the compact one shows only the count.
  const word = upvoted ? "Important" : "Mark important";
  const label = isMd
    ? `${word} ${count}${
        readOnly ? ", marking unavailable" : upvoted ? ", click to remove your mark" : ""
      }`
    : `Importance ${count}${
        readOnly
          ? `${upvoted ? ", marked important" : ""}, marking unavailable`
          : upvoted
            ? ", marked important, click to remove"
            : ", click to mark important"
      }`;
  const title = upvoted ? "Remove your importance mark" : "Mark important";
  const tone = upvoted
    ? "border-electric-blue-strong bg-electric-blue-strong text-white hover:border-electric-blue-strong hover:bg-electric-blue-strong"
    : "border-zk-border bg-zk-surface text-zk-text hover:border-zk-border hover:bg-zk-chip";

  const errorLine = error ? (
    <p
      id={errorId}
      className={`inline-flex items-center gap-1.5 text-xs font-medium text-red-700 ${isMd ? "" : "max-w-[9rem] justify-center text-center"}`}
      role="alert"
    >
      <AlertIcon className="h-3.5 w-3.5 shrink-0 text-red-600" />
      <span>{error}</span>
    </p>
  ) : null;

  if (isMd) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={pending || readOnly}
            aria-pressed={upvoted}
            aria-label={label}
            title={title}
            aria-describedby={error ? errorId : undefined}
            onClick={handleVote}
            className={`group inline-flex h-11 items-center justify-center gap-2 rounded-full border px-4 text-sm font-bold transition-all duration-150 active:scale-95 disabled:opacity-50 ${tone}`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="transition-transform group-hover:-translate-y-0.5">
              <path d="m18 15-6-6-6 6" />
            </svg>
            <span>{word}</span>{" "}
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${
                upvoted ? "bg-white/25 text-white" : "bg-zk-tint text-zk-accent"
              }`}
            >
              {count}
            </span>
          </button>
          {showAvatars ? <VoterAvatars voters={likeVoters} totalCount={count} size="md" /> : null}
        </div>
        {errorLine}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        disabled={pending || readOnly}
        aria-pressed={upvoted}
        aria-label={label}
        title={title}
        aria-describedby={error ? errorId : undefined}
        onClick={handleVote}
        className={`group inline-flex min-w-[2.75rem] flex-col items-center justify-center rounded-lg border px-2 py-1 text-xs font-semibold shadow-xs transition-all duration-150 active:scale-95 disabled:opacity-50 ${tone}`}
      >
        {chevron ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg>
        ) : <ThumbsUp filled={upvoted} className="h-3.5 w-3.5 transition-transform group-hover:scale-110" />}
        <span className="mt-0.5 tabular-nums leading-tight">{count}</span>
      </button>
      {errorLine}
    </div>
  );
}
