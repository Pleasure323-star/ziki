// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CommentNode } from "@/lib/comments";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/app/actions/comments", () => ({
  deleteCommentAction: vi.fn(),
  updateCommentAction: vi.fn(),
}));

import { CommentThread } from "./comment-thread";

const comment: CommentNode = {
  id: "c1",
  authorId: "ann",
  parentId: null,
  body: "My own comment.",
  createdAt: new Date("2026-10-22T00:00:00Z"),
  depth: 0,
  author: { name: "Ann", role: "user" },
  parent: null,
  children: [],
};

afterEach(cleanup);

describe("earlier comment actions (pencil)", () => {
  it("is a disclosure, not an ARIA menu, offering only Delete: earlier comments are read-only", () => {
    render(<CommentThread issueUrl="https://example.com/issues/b1" reporterId="ann" users={[]} comments={[comment]} currentUserId="ann" />);
    const pencil = screen.getByRole("button", { name: "Comment actions" });
    expect(pencil).not.toHaveAttribute("aria-haspopup");
    fireEvent.click(pencil);
    expect(pencil).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });

  it("closes on Escape and puts focus back on the pencil", () => {
    render(<CommentThread issueUrl="https://example.com/issues/b1" reporterId="ann" users={[]} comments={[comment]} currentUserId="ann" />);
    const pencil = screen.getByRole("button", { name: "Comment actions" });
    fireEvent.click(pencil);
    screen.getByRole("button", { name: "Delete" }).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(pencil).toHaveFocus();
  });

  it("offers nothing on someone else's comment", () => {
    render(<CommentThread issueUrl="https://example.com/issues/b1" reporterId="ann" users={[]} comments={[comment]} currentUserId="bob" />);
    expect(screen.queryByRole("button", { name: "Comment actions" })).toBeNull();
  });
});
