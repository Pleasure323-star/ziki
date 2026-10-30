// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ award: vi.fn() }));
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
  it("shows each bid like a confirmation, without expanding: its state, agent, owner, summary, description and replies", () => {
    render(<IssueBidsPanel bids={[bid]} canAward={false} />);
    const section = screen.getByTestId("bids");
    expect(section.tagName).toBe("SECTION");
    expect(screen.getByRole("heading", { name: /Bids/ })).toBeVisible();
    expect(screen.getByTestId("bid-state")).toHaveTextContent("Open");
    expect(screen.getByText("Ada's Claude")).toBeInTheDocument();
    expect(screen.getByText("for Ada")).toBeInTheDocument();
    expect(screen.getByText("Area match")).toBeInTheDocument();
    expect(screen.getByText(bid.summary)).toBeInTheDocument();
    expect(screen.getByText(bid.description)).toBeInTheDocument();
    expect(screen.getByText("Please add a regression test.")).toBeInTheDocument();
    expect(screen.queryByText(/Only agents bid/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Award bid" })).toBeNull();
  });

  it("is one compact card past Open, collapsed, naming the awarded bid, and expands to the bids without Award", async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <IssueBidsPanel
       
        bids={[{ ...bid, awardedAt: new Date("2026-10-29T12:00:00Z") }, { ...bid, id: "bid2", agentName: "Bob's agent" }]}
        canAward
        collapsed
      />,
    );
    const card = screen.getByTestId("bids");
    expect(card.tagName).toBe("DETAILS");
    expect(card).not.toHaveAttribute("open");
    expect(card).toHaveTextContent("Awarded to Ada's Claude for Ada");
    await user.click(screen.getByText("Bids"));
    expect(card).toHaveAttribute("open");
    expect(screen.getByText("Bob's agent")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Award bid" })).toBeNull();
  });

  it("offers Award bid only on an open bid", () => {
    render(
      <IssueBidsPanel
       
        bids={[bid, { ...bid, id: "bid2", withdrawnAt: new Date("2026-10-29T12:00:00Z") }]}
        canAward
      />,
    );
    expect(screen.getAllByRole("button", { name: "Award bid" })).toHaveLength(1);
  });

  it("lists awarded and withdrawn bids with the open ones, and counts the open ones", () => {
    render(
      <IssueBidsPanel
       
        bids={[bid, { ...bid, id: "bid2", awardedAt: new Date("2026-10-29T12:00:00Z") }, { ...bid, id: "bid3", withdrawnAt: new Date("2026-10-29T12:00:00Z") }]}
        canAward={false}
      />,
    );
    expect(screen.getByText("Awarded")).toBeInTheDocument();
    expect(screen.getByText("Withdrawn")).toBeInTheDocument();
    expect(screen.getByText("· 1 open")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });

  it("says when there are no bids yet", () => {
    render(<IssueBidsPanel bids={[]} canAward={false} />);
    expect(screen.getByText("No bids yet.")).toBeInTheDocument();
  });

  it("takes no replies: a bid card has no Reply button", () => {
    render(<IssueBidsPanel bids={[bid]} canAward={false} />);
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });

  it("says an Open issue nobody has is waiting for bids", () => {
    render(<IssueBidsPanel bids={[]} canAward={false} waiting />);
    expect(screen.getByTestId("bids-waiting")).toHaveTextContent("Open: waiting for bids");
  });
});
