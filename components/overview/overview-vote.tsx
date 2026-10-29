"use client";

import { useState, useTransition } from "react";
import { toggleVoteAction } from "@/app/actions/issues";

/**
 * Compact "Mark important" pill for the Overview assigned-issues table (#importance).
 * Same action as VoteButton; styled to match the redesign mockup.
 */
export function OverviewVote({
  bugId,
  voteCount,
  voted = false,
}: {
  bugId: string;
  voteCount: number;
  voted?: boolean;
}) {
  const [upvoted, setUpvoted] = useState(voted);
  const [count, setCount] = useState(Math.max(0, voteCount));
  const [pending, startTransition] = useTransition();

  const onClick = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const prev = { upvoted, count };
    setUpvoted(!upvoted);
    setCount(upvoted ? Math.max(0, count - 1) : count + 1);
    startTransition(async () => {
      const result = await toggleVoteAction(bugId, 1);
      if (result.error) {
        setUpvoted(prev.upvoted);
        setCount(prev.count);
        return;
      }
      if (typeof result.likeCount === "number") setCount(result.likeCount);
      if (typeof result.userVote === "number") setUpvoted(result.userVote === 1);
      else if (typeof result.voted === "boolean") setUpvoted(result.voted);
    });
  };

  return (
    <button
      type="button"
      disabled={pending}
      aria-pressed={upvoted}
      aria-label={
        upvoted
          ? `Importance ${count}, marked important, click to remove your mark`
          : `Importance ${count}, click to mark important`
      }
      title={upvoted ? "Remove your importance mark" : "Mark important"}
      onClick={onClick}
      className={`inline-flex h-9 w-[52px] shrink-0 items-center justify-center gap-1 rounded-full border text-[13px] font-bold tabular-nums transition disabled:opacity-50 ${
        upvoted
          ? "border-electric-blue-strong bg-electric-blue-strong text-white"
          : "border-zk-border bg-zk-surface text-zk-text hover:border-electric-blue-strong hover:text-zk-accent"
      }`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m18 15-6-6-6 6" />
      </svg>
      {count}
    </button>
  );
}
