// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// The Award button posts to a server action; the panel only decides where it shows.
vi.mock("@/app/actions/issue-bids", () => ({ awardIssueBidAction: vi.fn() }));

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

afterEach(() => cleanup());

describe("IssueBidsPanel (#issue-bids)", () => {
  it("shows each bid like a confirmation, without expanding: its state, agent, owner, summary, description and replies", () => {
    render(<IssueBidsPanel bids={[bid]} />);
    expect(screen.getByRole("heading", { name: /Bids/ })).toBeVisible();
    // An open bid: one state chip, with its vote count under it.
    expect(screen.getAllByTestId("bid-state")).toHaveLength(1);
    expect(screen.getByTestId("bid-votes").textContent?.match(/\d+/)?.[0]).toBe("0");
    expect(screen.getByText("Ada's Claude")).toBeInTheDocument();
    expect(screen.getByText("for Ada")).toBeInTheDocument();
    expect(screen.getByText(/area match/i)).toBeInTheDocument();
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
        collapsed
      />,
    );
    const card = screen.getByTestId("bids");
    expect(card).not.toHaveAttribute("open");
    expect(card).toHaveTextContent(/Ada's Claude/);
    await user.click(screen.getByText("Bids"));
    expect(card).toHaveAttribute("open");
    expect(screen.getByText("Bob's agent")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Award bid" })).toBeNull();
  });

  it("shows each open bid's votes, and no Award button: a manager agent awards through the API", () => {
    render(<IssueBidsPanel bids={[{ ...bid, votes: 3 }, { ...bid, id: "bid2", agentName: "Bob's agent", votes: 1 }, { ...bid, id: "bid3", agentName: "Cara's agent" }]} />);
    expect(screen.getAllByTestId("bid-votes").map((votes) => votes.textContent?.match(/\d+/)?.[0])).toEqual(["3", "1", "0"]);
    expect(screen.queryByRole("button", { name: /Award/ })).toBeNull();
  });

  it("lists awarded and withdrawn bids with the open ones, and counts the open ones", () => {
    render(
      <IssueBidsPanel
        bids={[bid, { ...bid, id: "bid2", awardedAt: new Date("2026-10-29T12:00:00Z") }, { ...bid, id: "bid3", withdrawnAt: new Date("2026-10-29T12:00:00Z") }]}
      />,
    );
    expect(screen.getByText("Awarded")).toBeInTheDocument();
    expect(screen.getByText("Withdrawn")).toBeInTheDocument();
    // The heading counts the one bid still open.
    expect(screen.getByRole("heading", { name: /Bids/ })).toHaveTextContent(/·\s*1\s/);
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });

  it("takes no replies: a bid card has no Reply button", () => {
    render(<IssueBidsPanel bids={[bid]} />);
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });

  it("names each award state, and lists the award first", () => {
    const at = new Date("2026-10-29T12:00:00Z");
    render(
      <IssueBidsPanel
        bids={[
          { ...bid, id: "open1", agentName: "Open agent" },
          { ...bid, id: "released1", agentName: "Released agent", awardedAt: at, awardReleasedAt: at },
          { ...bid, id: "expired1", agentName: "Expired agent", awardedAt: at, awardExpired: true },
          { ...bid, id: "offered1", agentName: "Offered agent", awardedAt: at, awardPending: true },
        ]}
      />,
    );
    expect(screen.getAllByTestId("bid-state").map((chip) => chip.textContent)).toEqual(["Offered", "Bid", "Expired", "Released"]);
    const released = screen.getByTestId("bid-released");
    expect(released).toHaveTextContent("Released agent");
    expect(released.querySelector("[data-testid=bid-votes]")).toBeNull();
  });

  it("reads Awarded once the offer is accepted", () => {
    render(<IssueBidsPanel bids={[bid, { ...bid, id: "bid2", awardedAt: new Date("2026-10-29T12:00:00Z") }]} />);
    expect(screen.getAllByTestId("bid-state").map((chip) => chip.textContent)).toEqual(["Awarded", "Bid"]);
  });

  it("offers Award on open bids only, and only to a viewer who can award", () => {
    const at = new Date("2026-10-29T12:00:00Z");
    const bids: BidEntryView[] = [
      { ...bid, id: "open1", agentName: "Open agent" },
      { ...bid, id: "open2", agentName: "Second agent" },
      { ...bid, id: "withdrawn1", agentName: "Withdrawn agent", withdrawnAt: at },
      { ...bid, id: "released1", agentName: "Released agent", awardedAt: at, awardReleasedAt: at },
    ];
    const { unmount } = render(<IssueBidsPanel bids={bids} canAward />);
    const buttons = screen.getAllByRole("button", { name: /Award/ });
    expect(buttons).toHaveLength(2);
    const awardedIds = buttons.map((button) => (button.closest("form")?.querySelector("input[name=bidId]") as HTMLInputElement | null)?.value);
    expect(awardedIds).toEqual(["open1", "open2"]);
    expect(screen.getByTestId("bid-withdrawn").querySelector("button")).toBeNull();
    expect(screen.getByTestId("bid-released").querySelector("button")).toBeNull();
    unmount();

    render(<IssueBidsPanel bids={bids} />);
    expect(screen.queryByRole("button", { name: /Award/ })).toBeNull();
  });

  it("marks an open bid whose bidder is at capacity, and offers no Award button for it (#bidder-capacity)", () => {
    render(<IssueBidsPanel bids={[{ ...bid, id: "full", agentName: "Pixel", atCapacity: true }, { ...bid, id: "free", agentName: "Cara's agent" }]} canAward />);
    const marks = screen.getAllByTestId("bid-at-capacity");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent("at capacity");
    expect(marks[0].closest("li")).toHaveTextContent("Pixel");
    const buttons = screen.getAllByRole("button", { name: /Award/ });
    expect(buttons.map((button) => (button.closest("form")?.querySelector("input[name=bidId]") as HTMLInputElement | null)?.value)).toEqual(["free"]);
  });

  it("shows a withdrawn bid without its description", () => {
    render(
      <IssueBidsPanel bids={[bid, { ...bid, id: "bid2", summary: "Withdrawn plan.", description: "Hidden description.", withdrawnAt: new Date("2026-10-29T12:00:00Z") }]} />,
    );
    const withdrawn = screen.getByTestId("bid-withdrawn");
    expect(withdrawn).toHaveTextContent("Withdrawn");
    expect(withdrawn).toHaveTextContent("Withdrawn plan.");
    expect(screen.queryByText("Hidden description.")).toBeNull();
  });
});
