// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ addComment: vi.fn(), award: vi.fn() }));
vi.mock("@/app/actions/issues", () => ({ addCommentAction: mocks.addComment }));
vi.mock("@/app/actions/issue-bids", () => ({ awardIssueBidAction: mocks.award }));

import { IssueBidsPanel, type BidEntryView } from "./issue-bids";

const bid: BidEntryView = {
  id: "bid1",
  agentName: "Ada's Claude",
  by: "Ada",
  summary: "I can fix the login redirect today.",
  description: "The session cookie is dropped on redirect. I will keep it and add a test.",
  areaMatch: true,
  updatedAt: new Date("2026-10-29T10:00:00Z"),
  replies: [{ id: "r1", body: "Please add a regression test.", authorName: "Cara", agentName: null, createdAt: new Date("2026-10-29T11:00:00Z") }],
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("IssueBidsPanel (#issue-bids)", () => {
  it("shows each bid's agent, owner, summary, description and replies, and tells people only agents bid", () => {
    render(<IssueBidsPanel bugId="bug1" bids={[bid]} canAward={false} canReply />);
    expect(screen.getByRole("heading", { name: /Bids/ })).toBeInTheDocument();
    expect(screen.getByText("Ada's Claude")).toBeInTheDocument();
    expect(screen.getByText("for Ada")).toBeInTheDocument();
    expect(screen.getByText("Area match")).toBeInTheDocument();
    expect(screen.getByText(bid.summary)).toBeInTheDocument();
    expect(screen.getByText(bid.description)).toBeInTheDocument();
    expect(screen.getByText("Please add a regression test.")).toBeInTheDocument();
    expect(screen.getByTestId("bids-people-note")).toHaveTextContent("Only agents bid");
    expect(screen.queryByRole("button", { name: "Award bid" })).toBeNull();
  });

  it("offers Award bid to whoever may award", () => {
    render(<IssueBidsPanel bugId="bug1" bids={[bid]} canAward canReply />);
    expect(screen.getByRole("button", { name: "Award bid" })).toBeInTheDocument();
  });

  it("shows the read-only history once the issue left Open: awarded and withdrawn, no reply or award (#entry-replies-only)", () => {
    render(
      <IssueBidsPanel
        bugId="bug1"
        bids={[{ ...bid, awardedAt: new Date("2026-10-29T12:00:00Z") }, { ...bid, id: "bid2", withdrawnAt: new Date("2026-10-29T12:00:00Z") }]}
        canAward={false}
        canReply={false}
        history
      />,
    );
    expect(screen.getByText("Awarded")).toBeInTheDocument();
    expect(screen.getByText("Withdrawn")).toBeInTheDocument();
    expect(screen.queryByTestId("bids-people-note")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });

  it("says when there are no bids yet", () => {
    render(<IssueBidsPanel bugId="bug1" bids={[]} canAward={false} canReply />);
    expect(screen.getByText("No bids yet.")).toBeInTheDocument();
  });

  it("replies to a bid with its bidId, as a plain comment", async () => {
    const user = userEvent.setup({ delay: null });
    mocks.addComment.mockResolvedValue({});
    render(<IssueBidsPanel bugId="bug1" bids={[bid]} canAward={false} canReply />);
    await user.click(screen.getByRole("button", { name: "Reply" }));
    await user.type(screen.getByRole("textbox"), "Go ahead.");
    await user.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(mocks.addComment).toHaveBeenCalledTimes(1));
    const [bugId, data] = mocks.addComment.mock.calls[0] as [string, FormData];
    expect(bugId).toBe("bug1");
    expect(data.get("bidId")).toBe("bid1");
    expect(data.get("confirmationId")).toBeNull();
    expect(data.get("body")).toBe("Go ahead.");
  });
});
