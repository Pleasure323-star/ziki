import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/app/actions/comments", () => ({
  deleteCommentAction: vi.fn(),
  updateCommentAction: vi.fn(),
}));

import { CommentThread } from "./comment-thread";
import type { CommentNode } from "@/lib/comments";

describe("CommentThread permalinks (#142)", () => {
  it("renders comment id, scroll-mt-24, and timestamp permalink anchor", () => {
    const comments: CommentNode[] = [
      {
        id: "c1",
        authorId: "u1",
        parentId: null,
        body: "First comment",
        createdAt: new Date("2026-10-16T12:00:00Z"),
        editedAt: null,
        deletedAt: null,
        depth: 0,
        author: {
          name: "Alice",
          role: "user",
        },
        parent: null,
        children: [],
      },
    ];

    const html = renderToStaticMarkup(
      createElement(CommentThread, {
        issueUrl: "https://issues.example/bugs/b1",
        reporterId: "u1",
        comments,
        users: [{ id: "u1", name: "Alice" }],
      }),
    );

    expect(html).toContain('id="comment-c1"');
    expect(html).toContain("scroll-mt-24");
    expect(html).toContain('href="#comment-c1"');
    // A permalink copy control beside the timestamp, with a real name (#279).
    expect(html).toContain('aria-label="Copy link to this comment"');
  });
});

describe("CommentThread read-only mode (#122)", () => {
  const comments: CommentNode[] = [
    {
      id: "c1",
      authorId: "u1",
      parentId: null,
      body: "First comment",
      createdAt: new Date("2026-10-16T12:00:00Z"),
      editedAt: null,
      deletedAt: null,
      depth: 0,
      author: { name: "Alice", role: "user" },
      parent: null,
      children: [],
    },
  ];

  const render = (readOnly: boolean) =>
    renderToStaticMarkup(
      createElement(CommentThread, {
        issueUrl: "https://issues.example/bugs/b1",
        reporterId: "u1",
        comments,
        users: [{ id: "u1", name: "Alice" }],
        currentUserId: "u1",
        currentUserRole: "user",
        readOnly,
      }),
    );

  it("never offers a form, Reply or Edit: earlier comments are read-only (#entry-replies-only)", () => {
    for (const readOnly of [false, true]) {
      const html = render(readOnly);
      expect(html).not.toContain("<form");
      expect(html).not.toContain(">Reply<");
      expect(html).not.toContain(">Edit<");
    }
  });

  it("offers the author's delete only while the issue is not deleted", () => {
    expect(render(false)).toContain('aria-label="Comment actions"');
    expect(render(true)).not.toContain('aria-label="Comment actions"');
  });

  it("shows no type badges or confidence: comments have no type or metadata", () => {
    const html = render(false);
    expect(html).not.toMatch(/>Bid<|>Review<|>Delivery<|Self-reported confidence/);
  });
});

describe("CommentThread Admin label (#489)", () => {
  const comment = (id: string, authorId: string, role: "user" | "admin"): CommentNode => ({
    id,
    authorId,
    parentId: null,
    body: `Comment ${id}`,
    createdAt: new Date("2026-10-21T12:00:00Z"),
    editedAt: null,
    deletedAt: null,
    depth: 0,
    author: { name: `Person ${authorId}`, role },
    parent: null,
    children: [],
  });

  const render = (organizationRoles?: Record<string, "owner" | "admin" | "member">) =>
    renderToStaticMarkup(
      createElement(CommentThread, {
        issueUrl: "https://issues.example/bugs/b1",
        reporterId: "r1",
        comments: [comment("c1", "u1", "admin"), comment("c2", "u2", "user")],
        users: [],
        organizationRoles,
      }),
    );

  it("labels only authors who are admins of this organization", () => {
    const html = render({ u1: "member", u2: "admin" });
    expect(html.match(/aria-label="Administrator"/g)).toHaveLength(1);
    const second = html.slice(html.indexOf('id="comment-c2"'));
    expect(second).toContain('aria-label="Administrator"');
  });

  it("does not label an account-wide admin when no organization role is known", () => {
    expect(render()).not.toContain('aria-label="Administrator"');
  });
});
