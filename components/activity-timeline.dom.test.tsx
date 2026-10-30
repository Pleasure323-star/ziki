// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityTimeline, type ActivityEntry } from "./activity-timeline";

let seq = 0;
function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  seq += 1;
  return {
    id: `activity-${seq}`,
    type: "commented",
    summary: "Left a note on the ticket",
    createdAt: new Date("2026-01-01T10:00:00.000Z"),
    actor: { name: "Alice" },
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("ActivityTimeline: the newest two, the rest behind Show earlier", () => {
  it("shows the newest two entries on one line each, with no type label or read-only note", () => {
    const { container } = render(
      <ActivityTimeline
        activities={[entry({ summary: "first" }), entry({ summary: "second" }), entry({ summary: "third", actor: { name: "Bob" } })]}
        totalCount={3}
      />,
    );
    expect(screen.getByText("Activity (3)")).toBeInTheDocument();
    expect(screen.queryByText(/Read-only history/)).toBeNull();
    expect(screen.queryByText("Comment")).toBeNull();
    const lists = container.querySelectorAll("ol");
    expect(lists).toHaveLength(2);
    // The earlier one is hidden until the toggle is ticked; the newest two show.
    expect(lists[0]).toHaveClass("hidden");
    expect(lists[0]).toHaveTextContent("first");
    expect(lists[1]).not.toHaveClass("hidden");
    expect(lists[1]).toHaveTextContent("second");
    expect(lists[1]).toHaveTextContent("Bob third");
    expect(lists[1].querySelectorAll("time")).toHaveLength(2);
  });

  it("puts the Show earlier toggle under the entries, counting what isn't loaded too", async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(
      <ActivityTimeline activities={[entry(), entry(), entry()]} totalCount={5} />,
    );
    const toggle = screen.getByRole("checkbox");
    expect(container.querySelector("section")!.lastElementChild).toContainElement(toggle);
    expect(screen.getByText(/Show 1 earlier \(of 3\)/)).toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toBeChecked();
  });

  it("has no toggle when there are two entries or fewer", () => {
    render(<ActivityTimeline activities={[entry(), entry()]} totalCount={2} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("says so when an issue has no activity", () => {
    const { container } = render(
      <ActivityTimeline activities={[]} totalCount={0} />,
    );

    expect(container.querySelector("ol")).toBeNull();
    expect(screen.getByText("No activity recorded yet.")).toBeVisible();
  });
});
