// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { OutcomeRadar } from "./outcome-radar";

const QUESTION = /hold #1441 until the regression test lands/i;

describe("Outcome radar (prototype)", () => {
  afterEach(cleanup);

  it("leads with the intended outcome, then the decision, with agent activity below", () => {
    render(<OutcomeRadar />);

    expect(screen.getByRole("heading", { name: /outcome radar/i })).toBeInTheDocument();
    expect(screen.getByText(/intended outcome/i)).toBeInTheDocument();
    expect(
      screen.getByText(/live on friday: the agent offer flow on main/i),
    ).toBeInTheDocument();

    // The decision banner carries the compact question in the overview state…
    expect(screen.getByText(QUESTION)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Review decision" }),
    ).toHaveAttribute("aria-expanded", "false");
    // …and the panel does not exist yet.
    expect(
      screen.queryByRole("region", { name: /#1441 · login outage patch/i }),
    ).not.toBeInTheDocument();

    // Routine agent activity is secondary, in a compact list.
    expect(screen.getByRole("heading", { name: /agent activity/i })).toBeInTheDocument();
    expect(screen.getByText(/requested changes on #1441/i)).toBeInTheDocument();

    // Fictional-data provenance is always stated.
    expect(screen.getByText(/fictional prototype data/i)).toBeInTheDocument();
  });

  it("expands the inline panel with risk, evidence, trade-offs and choices", () => {
    render(<OutcomeRadar />);

    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));

    const panel = screen.getByRole("region", { name: /#1441 · login outage patch/i });
    expect(screen.getByRole("button", { name: "Close decision panel" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(panel).getByRole("heading", { name: /^risk/i })).toBeInTheDocument();
    expect(within(panel).getByText(/high risk/i)).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: /^evidence/i })).toBeInTheDocument();
    expect(within(panel).getByText(/merger rejection · mika/i)).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: /^trade-offs/i })).toBeInTheDocument();
    expect(within(panel).getByText(/wait for the regression test/i)).toBeInTheDocument();

    const group = within(panel).getByRole("radiogroup", {
      name: /how should the agents proceed/i,
    });
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
    expect(within(group).getByRole("radio", { name: /verify first/i })).toBeChecked();
  });

  it("shows the question exactly once while the panel is open (no duplicated content)", () => {
    render(<OutcomeRadar />);

    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));

    // The compact strip replaces the banner's question; the panel owns it.
    expect(screen.getAllByText(QUESTION)).toHaveLength(1);
    expect(screen.getAllByText(/#1441 · login outage patch/i)).toHaveLength(1);
    expect(screen.getByText(/decision open/i)).toBeInTheDocument();
  });

  it("updates the consequence preview when the human picks another way to proceed", () => {
    render(<OutcomeRadar />);

    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    const panel = screen.getByRole("region", { name: /#1441 · login outage patch/i });
    const group = within(panel).getByRole("radiogroup", {
      name: /how should the agents proceed/i,
    });

    fireEvent.click(within(group).getByRole("radio", { name: /fast-track/i }));
    expect(within(group).getByRole("radio", { name: /fast-track/i })).toBeChecked();
    expect(screen.getByText(/on confirm, agents will fast-track #1441/i)).toBeInTheDocument();

    fireEvent.click(within(group).getByRole("radio", { name: /bring me in/i }));
    expect(screen.getByText(/on confirm, agents will pause #1441/i)).toBeInTheDocument();
  });

  it("records the confirmed choice and spells out the consequence", () => {
    render(<OutcomeRadar />);

    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm choice" }));

    expect(screen.getByRole("button", { name: /choice recorded/i })).toBeInTheDocument();
    expect(screen.getByText(/recorded — agents will hold #1441/i)).toBeInTheDocument();
  });

  it("collapses back to the overview with the collapse control and restores focus", async () => {
    render(<OutcomeRadar />);

    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: /#1441 · login outage patch/i }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Review decision" })).toHaveFocus(),
    );
  });

  it("collapses back to the overview with Escape", () => {
    render(<OutcomeRadar />);

    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    const panel = screen.getByRole("region", { name: /#1441 · login outage patch/i });
    fireEvent.keyDown(panel, { key: "Escape" });

    expect(
      screen.queryByRole("region", { name: /#1441 · login outage patch/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review decision" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});
