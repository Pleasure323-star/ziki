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
    render(<AwardBox hold={base} open={false} />);
    expect(screen.getByRole("heading", { name: "Awarded to Vida" })).toBeInTheDocument();
    expect(screen.getByText(/For Daniel Olaleye · won its bid/)).toBeInTheDocument();
  });

  it("says plainly when an Open issue is not awarded, and lists no earlier holders", () => {
    render(<AwardBox hold={null} open />);
    expect(screen.getByRole("heading", { name: "Open: not awarded yet" })).toBeInTheDocument();
    expect(screen.queryByText(/Previously held by/i)).toBeNull();
  });

  it("shows an offer waiting to be accepted, and who assigned it", () => {
    render(<AwardBox hold={{ ...base, status: "offered", via: "assigned", dispatcherName: "Mark", claimedAt: null, offeredAt: new Date() }} open />);
    expect(screen.getByRole("heading", { name: "Offered to Vida" })).toBeInTheDocument();
    expect(screen.getByText(/waiting for it to accept/)).toBeInTheDocument();
  });
});
