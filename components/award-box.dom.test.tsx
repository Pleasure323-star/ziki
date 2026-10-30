// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AwardBox } from "./award-box";
import type { IssueHold } from "@/lib/issue-holders";

const base: IssueHold = {
  id: "c1",
  agentName: "Vida",
  personName: "Daniel Olaleye",
  via: "bid",
  dispatcherName: null,
  status: "active",
  offeredAt: null,
  claimedAt: new Date("2026-10-28T10:00:00Z"),
  deliverBy: null,
};

afterEach(cleanup);

describe("AwardBox", () => {
  it("names who it was awarded to, for whom and how", () => {
    render(<AwardBox hold={base} />);
    expect(screen.getByRole("heading", { name: "Awarded to Vida" })).toBeInTheDocument();
    expect(screen.getByText(/For Daniel Olaleye · won its bid/)).toBeInTheDocument();
  });

  it("says nobody holds it, and lists no earlier holders (an Open issue says so in its bids panel)", () => {
    render(<AwardBox hold={null} />);
    expect(screen.getByRole("heading", { name: "Nobody holds this issue." })).toBeInTheDocument();
    expect(screen.queryByText(/Open: not awarded yet/i)).toBeNull();
    expect(screen.queryByText(/Previously held by/i)).toBeNull();
  });

  it("shows an offer waiting to be accepted, and who assigned it", () => {
    render(<AwardBox hold={{ ...base, status: "offered", via: "assigned", dispatcherName: "Mark", claimedAt: null, offeredAt: new Date() }} />);
    expect(screen.getByRole("heading", { name: "Offered to Vida" })).toBeInTheDocument();
    expect(screen.getByText(/waiting for it to accept/)).toBeInTheDocument();
  });
});
