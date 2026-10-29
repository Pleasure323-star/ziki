import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/actions/issues", () => ({
  toggleVoteAction: vi.fn(),
}));

import { VoteButton } from "./vote-button";

const countDisabled = (html: string) =>
  (html.match(/<button[^>]*disabled=""/g) ?? []).length;

describe("VoteButton read-only mode (#122)", () => {
  for (const size of ["sm", "md"] as const) {
    it(`keeps the upvote enabled normally (${size})`, () => {
      const html = renderToStaticMarkup(
        createElement(VoteButton, { bugId: "b1", voteCount: 3, size }),
      );
      expect(countDisabled(html)).toBe(0);
    });

    it(`disables the upvote but still shows the count on deleted issues (${size})`, () => {
      const html = renderToStaticMarkup(
        createElement(VoteButton, {
          bugId: "b1",
          voteCount: 3,
          likeCount: 3,
          size,
          readOnly: true,
        }),
      );
      expect(countDisabled(html)).toBe(1);
      expect(html).toContain("3");
      expect(html).toContain(
        size === "sm"
          ? 'aria-label="Importance 3, marking unavailable"'
          : 'aria-label="Mark important 3, marking unavailable"',
      );
      expect(html).not.toContain("click to");
    });

    it(`preserves the upvoted state without click instructions when read-only (${size})`, () => {
      const html = renderToStaticMarkup(
        createElement(VoteButton, {
          bugId: "b1",
          voteCount: 3,
          userVote: 1,
          size,
          readOnly: true,
        }),
      );
      expect(html).toContain(
        size === "sm"
          ? 'aria-label="Importance 3, marked important, marking unavailable"'
          : 'aria-label="Important 3, marking unavailable"',
      );
      expect(html).not.toContain("click to");
    });
  }
});
