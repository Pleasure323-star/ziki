// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/app/actions/issues", () => ({
  toggleVoteAction: vi.fn(),
}));

import { toggleVoteAction } from "@/app/actions/issues";
import { VoteButton } from "./vote-button";

const mockToggle = vi.mocked(toggleVoteAction);

describe("VoteButton interactive optimistic updates (#219)", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("optimistically updates like count on click and settles on server success", async () => {
    mockToggle.mockResolvedValueOnce({
      voteCount: 6,
      likeCount: 6,
      dislikeCount: 0,
      userVote: 1,
    });

    const user = userEvent.setup({ delay: null });
    render(
      <VoteButton
        bugId="bug-1"
        voteCount={5}
        likeCount={5}
        userVote={0}
      />
    );

    const upvoteButton = screen.getByRole("button", { name: /^Importance 5, click to mark important$/i });
    expect(upvoteButton).toHaveTextContent("5");

    await user.click(upvoteButton);

    // Optimistically updated
    expect(upvoteButton).toHaveTextContent("6");
    expect(mockToggle).toHaveBeenCalledWith("bug-1", 1);

    await waitFor(() => {
      expect(upvoteButton).toHaveTextContent("6");
    });
  });

  it("rolls back optimistic like count when server action returns an error", async () => {
    mockToggle.mockResolvedValueOnce({
      error: "You cannot vote on your own issue.",
    });

    const user = userEvent.setup({ delay: null });
    render(
      <VoteButton
        bugId="bug-1"
        voteCount={5}
        likeCount={5}
        userVote={0}
      />
    );

    const upvoteButton = screen.getByRole("button", { name: /^Importance 5, click to mark important$/i });
    expect(upvoteButton).toHaveTextContent("5");

    await user.click(upvoteButton);

    // Should rollback after error
    await waitFor(() => {
      expect(upvoteButton).toHaveTextContent("5");
      expect(screen.getByText("You cannot vote on your own issue.")).toBeInTheDocument();
    });
  });

  it("no longer shows an upvote readiness gate: upvotes don't gate the work (#idea-verdicts)", async () => {
    mockToggle.mockResolvedValueOnce({
      voteCount: 3,
      likeCount: 3,
      dislikeCount: 0,
      userVote: 1,
    });

    const user = userEvent.setup({ delay: null });
    render(
      <VoteButton
        bugId="bug-1"
        voteCount={2}
        likeCount={2}
        userVote={0}
        size="md"
      />
    );

    expect(screen.queryByTestId("readiness-gate-indicator")).toBeNull();
    expect(screen.queryByText(/unlock work/i)).toBeNull();

    // The large button's name starts with its visible "Mark important 2" (WCAG 2.5.3).
    const likeButton = screen.getByRole("button", { name: /^mark important 2/i });
    await user.click(likeButton);

    expect(screen.getByRole("button", { name: /^important 3/i })).toBeInTheDocument();
  });

  it("renders accessible error with icon, 12px minimum font, and aria-describedby linkage (#703)", async () => {
    mockToggle.mockResolvedValueOnce({
      error: "You cannot vote on your own issue.",
    });

    const user = userEvent.setup({ delay: null });
    render(
      <VoteButton
        bugId="bug-1"
        voteCount={5}
        likeCount={5}
        userVote={0}
      />
    );

    const upvoteButton = screen.getByRole("button", { name: /^Importance 5, click to mark important$/i });
    await user.click(upvoteButton);

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toHaveAttribute("id", "vote-error-bug-1");
      expect(alert).toHaveClass("text-xs");
      expect(alert.querySelector("svg")).toBeInTheDocument();
      expect(upvoteButton).toHaveAttribute("aria-describedby", "vote-error-bug-1");
    });
  });
});
