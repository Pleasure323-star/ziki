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
vi.mock("@/app/actions/issues", () => ({ addCommentAction: vi.fn() }));

import { IssueComments } from "./comment-thread";
import { CommentComposer } from "./comment-composer";

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

describe("IssueComments", () => {
  it("shows nothing when there are no comments and the issue takes none", () => {
    render(<IssueComments {...props} count={0} comments={[]} />);
    expect(screen.queryByTestId("issue-comments")).toBeNull();
  });

  it("shows the comments and their replies, open, under Comments", () => {
    render(<IssueComments {...props} count={1} comments={[comment]} />);
    expect(screen.getByTestId("issue-comments").tagName).toBe("SECTION");
    expect(screen.getByRole("heading", { name: /Comments/ })).toBeInTheDocument();
    expect(screen.getByText(comment.body)).toBeInTheDocument();
    expect(screen.getByText(reply.body)).toBeInTheDocument();
  });

  it("takes no comment or reply unless the issue is Open", () => {
    render(<IssueComments {...props} count={1} comments={[comment]} />);
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Add a comment" })).toBeNull();
  });

  it("while Open: a comment box, and Reply on top-level comments only", () => {
    render(
      <IssueComments {...props} count={1} comments={[comment]} replyBugId="bug1" composer={<CommentComposer bugId="bug1" />} />,
    );
    expect(screen.getByRole("form", { name: "Add a comment" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Reply" })).toHaveLength(1);
  });

  it("shows the comment box even before the first comment", () => {
    render(<IssueComments {...props} count={0} comments={[]} replyBugId="bug1" composer={<CommentComposer bugId="bug1" />} />);
    expect(screen.getByRole("form", { name: "Add a comment" })).toBeInTheDocument();
  });

  it("keeps an author's own delete, but not on a deleted issue", () => {
    const { unmount } = render(<IssueComments {...props} count={1} comments={[comment]} />);
    expect(screen.getByRole("button", { name: "Comment actions" })).toBeInTheDocument();
    unmount();
    render(<IssueComments {...props} count={1} comments={[comment]} readOnly />);
    expect(screen.queryByRole("button", { name: "Comment actions" })).toBeNull();
  });
});
