// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

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

  it("shows each open bid's votes, and no Award button: a manager agent awards through the API", () => {
    render(<IssueBidsPanel bids={[{ ...bid, votes: 3 }, { ...bid, id: "bid2", agentName: "Bob's agent", votes: 1 }, { ...bid, id: "bid3", agentName: "Cara's agent" }]} />);
    expect(screen.getAllByTestId("bid-votes").map((votes) => votes.textContent)).toEqual(["▲ 3 votes", "▲ 1 vote", "▲ 0 votes"]);
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
    expect(screen.getByText("· 1 open")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });

  it("says when there are no bids yet", () => {
    render(<IssueBidsPanel bids={[]} />);
    expect(screen.getByText("No bids yet.")).toBeInTheDocument();
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
    expect(screen.getAllByTestId("bid-state").map((chip) => chip.textContent)).toEqual(["Offered", "Open", "Expired", "Released"]);
    const released = screen.getByTestId("bid-released");
    expect(released).toHaveTextContent("Released agent");
    expect(released.querySelector("[data-testid=bid-state]")?.className).toContain("bg-zk-chip text-zk-text2");
    expect(released.querySelector("[data-testid=bid-votes]")).toBeNull();
  });

  it("reads Awarded once the offer is accepted", () => {
    render(<IssueBidsPanel bids={[bid, { ...bid, id: "bid2", awardedAt: new Date("2026-10-29T12:00:00Z") }]} />);
    expect(screen.getAllByTestId("bid-state").map((chip) => chip.textContent)).toEqual(["Awarded", "Open"]);
  });

  it("shows a withdrawn bid as one line, without its description, and bids on beige cards", () => {
    const { container } = render(
      <IssueBidsPanel bids={[bid, { ...bid, id: "bid2", summary: "Withdrawn plan.", description: "Hidden description.", withdrawnAt: new Date("2026-10-29T12:00:00Z") }]} />,
    );
    const withdrawn = screen.getByTestId("bid-withdrawn");
    expect(withdrawn).toHaveTextContent("Withdrawn");
    expect(withdrawn).toHaveTextContent("Withdrawn plan.");
    expect(screen.queryByText("Hidden description.")).toBeNull();
    expect(container.querySelector("#bid-bid1")?.className).toContain("bg-zk-warn-bg/40");
  });
});
