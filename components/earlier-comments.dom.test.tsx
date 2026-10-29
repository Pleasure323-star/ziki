// @vitest-environment happy-dom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CommentNode } from "@/lib/comments";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/app/actions/comments", () => ({
  deleteCommentAction: vi.fn(),
  updateCommentAction: vi.fn(),
}));

import { EarlierComments } from "./comment-thread";

const props = {
  issueUrl: "https://example.com/issues/issue-450",
  reporterId: "reporter",
  users: [],
  currentUserId: "reviewer",
};
const reply: CommentNode = {
  id: "the-reply",
  authorId: "someone",
  parentId: "first-comment",
  body: "And a reply to it.",
  createdAt: new Date("2026-10-22T01:00:00Z"),
  depth: 1,
  author: { name: "Someone", role: "user" },
  parent: null,
  children: [],
};
const comment: CommentNode = {
  id: "first-comment",
  authorId: "reviewer",
  parentId: null,
  body: "Here is some useful context.",
  createdAt: new Date("2026-10-22T00:00:00Z"),
  depth: 0,
  author: { name: "Reviewer", role: "user" },
  parent: null,
  children: [reply],
};

afterEach(cleanup);

describe("Earlier comments (#entry-replies-only)", () => {
  it("shows nothing when the issue has no comments from before entries", () => {
    render(<EarlierComments {...props} count={0} comments={[]} />);
    expect(screen.queryByTestId("earlier-comments")).toBeNull();
  });

  it("collapses the old comments, with their replies, under Earlier comments (N)", () => {
    render(<EarlierComments {...props} count={1} comments={[comment]} />);
    const section = screen.getByTestId("earlier-comments");
    expect(section.tagName).toBe("DETAILS");
    expect(section).not.toHaveAttribute("open");
    expect(screen.getByText("Earlier comments (1)")).toBeInTheDocument();
    expect(screen.getByText(comment.body)).toBeInTheDocument();
    expect(screen.getByText(reply.body)).toBeInTheDocument();
  });

  it("is read-only: no Reply, no Edit, no composer", () => {
    render(<EarlierComments {...props} count={1} comments={[comment]} defaultOpen />);
    expect(screen.getByTestId("earlier-comments")).toHaveAttribute("open");
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("keeps an author's own delete, but not on a deleted issue", () => {
    const { unmount } = render(<EarlierComments {...props} count={1} comments={[comment]} />);
    expect(screen.getByRole("button", { name: "Comment actions" })).toBeInTheDocument();
    unmount();
    render(<EarlierComments {...props} count={1} comments={[comment]} readOnly />);
    expect(screen.queryByRole("button", { name: "Comment actions" })).toBeNull();
  });

  it("opens when the URL points at one of its comments", () => {
    window.location.hash = "#comment-the-reply";
    render(<EarlierComments {...props} count={1} comments={[comment]} />);
    expect(screen.getByTestId("earlier-comments")).toHaveProperty("open", true);
    window.location.hash = "";
  });
});
