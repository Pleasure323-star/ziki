// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ addComment: vi.fn() }));
vi.mock("@/app/actions/issues", () => ({ addCommentAction: mocks.addComment }));

import { MergeReviewsPanel, TestVerdictsPanel, type MergeReviewView, type TestVerdictView } from "./issue-review-entries";

const PR = "https://github.com/emerjent/ziki/pull/42";

const verdict: TestVerdictView = {
  id: "tv1",
  agentName: "Bob's Claude",
  by: "Bob",
  goodToMerge: false,
  summary: "Not good to merge: Save still fails.",
  description: "Clicked Save twice on the PR head in Safari; the second click does nothing.",
  pullRequestUrl: PR,
  headSha: "abc1234def",
  current: true,
  updatedAt: new Date("2026-10-29T10:00:00Z"),
  replies: [{ id: "r1", body: "Which Safari version?", authorName: "Ada", agentName: null, createdAt: new Date("2026-10-29T11:00:00Z") }],
};

const review: MergeReviewView = {
  id: "mr1",
  agentName: "Dana's Claude",
  by: "Dana",
  verdict: "accept",
  summary: "Accept: small and tested.",
  description: "Two independent testers verified the head commit.",
  pullRequestUrl: PR,
  headSha: "0123456789",
  current: false,
  updatedAt: new Date("2026-10-29T12:00:00Z"),
  replies: [],
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("TestVerdictsPanel (#review-entries)", () => {
  it("shows each verdict's chip, agent, owner, summary, description, pull request and replies", () => {
    render(<TestVerdictsPanel bugId="bug1" verdicts={[verdict]} canReply />);
    expect(screen.getByRole("heading", { name: /Test verdicts/ })).toBeInTheDocument();
    expect(screen.getByText("Not good to merge")).toBeInTheDocument();
    expect(screen.getByText("Bob's Claude")).toBeInTheDocument();
    expect(screen.getByText("for Bob")).toBeInTheDocument();
    expect(screen.getByText(verdict.summary)).toBeInTheDocument();
    expect(screen.getByText(verdict.description)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PR #42" })).toHaveAttribute("href", PR);
    expect(screen.getByText("@ abc1234")).toBeInTheDocument();
    expect(screen.getByText("Which Safari version?")).toBeInTheDocument();
    expect(screen.queryByText("Earlier code")).toBeNull();
    expect(screen.getByTestId("test-verdicts-people-note")).toHaveTextContent("People don't give verdicts");
  });

  it("says when there are none yet", () => {
    render(<TestVerdictsPanel bugId="bug1" verdicts={[]} canReply />);
    expect(screen.getByText("No test verdicts yet.")).toBeInTheDocument();
  });

  it("replies to a verdict with a plain comment naming it", async () => {
    mocks.addComment.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<TestVerdictsPanel bugId="bug1" verdicts={[verdict]} canReply />);
    await user.click(screen.getByRole("button", { name: "Reply" }));
    const form = screen.getByRole("form", { name: "Reply to this test verdict" });
    await user.type(form.querySelector("textarea")!, "Safari 18.");
    await user.click(screen.getAllByRole("button", { name: "Reply" }).at(-1)!);
    await waitFor(() => expect(mocks.addComment).toHaveBeenCalledTimes(1));
    const [bugId, data] = mocks.addComment.mock.calls[0] as [string, FormData];
    expect(bugId).toBe("bug1");
    expect(data.get("testVerdictId")).toBe("tv1");
    expect(data.get("body")).toBe("Safari 18.");
    expect(data.get("type")).toBeNull();
  });
});

describe("MergeReviewsPanel (#review-entries)", () => {
  it("shows the manager's accept, marks a review of earlier code, and replies by mergeReviewId", async () => {
    mocks.addComment.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<MergeReviewsPanel bugId="bug1" reviews={[review]} canReply />);
    expect(screen.getByRole("heading", { name: /Merge reviews/ })).toBeInTheDocument();
    expect(screen.getByText("Accept")).toBeInTheDocument();
    expect(screen.getByText("Dana's Claude")).toBeInTheDocument();
    expect(screen.getByText("Earlier code")).toBeInTheDocument();
    expect(screen.getByText(review.summary)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reply" }));
    const form = screen.getByRole("form", { name: "Reply to this merge review" });
    await user.type(form.querySelector("textarea")!, "Thanks.");
    await user.click(screen.getAllByRole("button", { name: "Reply" }).at(-1)!);
    await waitFor(() => expect(mocks.addComment).toHaveBeenCalledTimes(1));
    expect((mocks.addComment.mock.calls[0][1] as FormData).get("mergeReviewId")).toBe("mr1");
  });
});
