// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CommentNode } from "@/lib/comments";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/app/actions/comments", () => ({ deleteCommentAction: vi.fn(), updateCommentAction: vi.fn(), upvoteCommentAction: vi.fn() }));

import { CommentThread } from "./comment-thread";

const base: CommentNode = {
  id: "c1",
  authorId: "ann",
  parentId: null,
  body: "The full reasoning.",
  createdAt: new Date("2026-10-22T00:00:00Z"),
  depth: 0,
  author: { name: "Ann", role: "user" },
  parent: null,
  children: [],
};

afterEach(cleanup);

describe("agent comments in the thread (#730, #729)", () => {
  it("shows an agent comment's summary above its body", () => {
    render(<CommentThread issueUrl="https://example.com/i/1" reporterId="rex" users={[]} comments={[{ ...base, agentId: "a1", agent: { name: "Pixel" }, summary: "The redirect drops the session." }]} />);
    const summary = screen.getByTestId("comment-summary");
    expect(summary).toHaveTextContent("The redirect drops the session.");
    expect(screen.getByText("The full reasoning.")).toBeInTheDocument();
    expect(summary.compareDocumentPosition(screen.getByText("The full reasoning.")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders an older comment with no summary as before", () => {
    render(<CommentThread issueUrl="https://example.com/i/1" reporterId="rex" users={[]} comments={[base]} />);
    expect(screen.queryByTestId("comment-summary")).toBeNull();
    expect(screen.getByText("The full reasoning.")).toBeInTheDocument();
  });

  it("says when an agent's owner marked the issue important, and nothing otherwise", () => {
    const agentComment = { ...base, agentId: "a1", agent: { name: "Pixel" } };
    const { rerender } = render(<CommentThread issueUrl="https://example.com/i/1" reporterId="rex" users={[]} comments={[agentComment]} markedImportantBy={["ann"]} />);
    expect(screen.getByTestId("comment-author-marked-important")).toBeInTheDocument();
    rerender(<CommentThread issueUrl="https://example.com/i/1" reporterId="rex" users={[]} comments={[agentComment]} markedImportantBy={["someone-else"]} />);
    expect(screen.queryByTestId("comment-author-marked-important")).toBeNull();
    // A person's own comment shows no indicator: the issue page shows their mark already.
    rerender(<CommentThread issueUrl="https://example.com/i/1" reporterId="rex" users={[]} comments={[base]} markedImportantBy={["ann"]} />);
    expect(screen.queryByTestId("comment-author-marked-important")).toBeNull();
  });
});
