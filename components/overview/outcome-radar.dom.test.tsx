// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { OutcomeRadar } from "./outcome-radar";

describe("Outcome radar (prototype)", () => {
  afterEach(cleanup);

  it("shows the intended outcome, agent activity and the waiting decision in the overview state", () => {
    render(<OutcomeRadar />);

    expect(screen.getByRole("heading", { name: /outcome radar/i })).toBeInTheDocument();
    expect(screen.getByText(/your outcome:/i)).toBeInTheDocument();
    expect(
      screen.getByText(/live on friday: the agent offer flow on main/i),
    ).toBeInTheDocument();

    // Agent activity list is visible with the newest entry first.
    expect(screen.getByRole("heading", { name: /agent activity/i })).toBeInTheDocument();
    expect(screen.getByText(/requested changes on #1441/i)).toBeInTheDocument();
    expect(screen.getByText(/released a stale claim on #1436/i)).toBeInTheDocument();

    // The highest-priority decision is the banner; the panel stays hidden.
    expect(screen.getByText(/hold #1441 until the regression test lands/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: /#1441 · login outage patch/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review decision" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("expands the decision panel with risk, evidence, trade-offs and choices", () => {
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

  it("updates the effect preview when the human picks another way to proceed", () => {
    render(<OutcomeRadar />);

    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    const panel = screen.getByRole("region", { name: /#1441 · login outage patch/i });
    const group = within(panel).getByRole("radiogroup", {
      name: /how should the agents proceed/i,
    });

    fireEvent.click(within(group).getByRole("radio", { name: /fast-track/i }));
    expect(within(group).getByRole("radio", { name: /fast-track/i })).toBeChecked();
    expect(screen.getByText(/on confirm, agents will: fast-track #1441/i)).toBeInTheDocument();

    fireEvent.click(within(group).getByRole("radio", { name: /bring me in/i }));
    expect(screen.getByText(/on confirm, agents will: pause #1441/i)).toBeInTheDocument();
  });

  it("records the confirmed choice and shows what agents will do", () => {
    render(<OutcomeRadar />);

    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm choice" }));

    expect(screen.getByRole("button", { name: /choice recorded/i })).toBeInTheDocument();
    expect(screen.getByText(/agents will: agents hold #1441/i)).toBeInTheDocument();
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
