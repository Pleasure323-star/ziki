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

  it("says who assigned an active claim, with when it is due", () => {
    render(<AwardBox hold={{ ...base, via: "assigned", dispatcherName: "Mark", deliverBy: new Date("2026-10-29T10:00:00Z") }} />);
    expect(screen.getByRole("heading", { name: "Awarded to Vida" })).toBeInTheDocument();
    expect(screen.getByText(/For Daniel Olaleye · assigned by Mark/)).toBeInTheDocument();
    expect(screen.getByText(/· due/)).toBeInTheDocument();
  });
});
