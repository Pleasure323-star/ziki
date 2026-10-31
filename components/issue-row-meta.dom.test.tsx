// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, within } from "@testing-library/react";
import { IssueRowMeta, MAX_VISIBLE_PILLS, type RowPill } from "./issue-row-meta";

/** A pill shaped like the page builds them, so the test proves the real contract. */
function pill(name: string): RowPill {
  return { name, className: "border-slate-200 bg-slate-100 text-slate-700" };
}

/** With no metadata line, the whole render is the pill row. */
function pillRow(container: HTMLElement): HTMLElement {
  return container;
}

describe("IssueRowMeta pill cap (#686)", () => {
  it("shows every pill when there are three or fewer, and no overflow chip", () => {
    const { container } = render(
      <IssueRowMeta pills={[pill("Critical"), pill("Open"), pill("Bug")]} meta={null} />
    );
    const row = pillRow(container);
    expect(within(row).queryByText(/^\+\d+$/)).toBeNull();
    for (const name of ["Critical", "Open", "Bug"]) {
      expect(within(row).getByText(name)).toBeInTheDocument();
    }
  });

  it("caps at three pills and folds the rest into a +N chip", () => {
    const { container } = render(
      <IssueRowMeta
        pills={[
          pill("Critical"),
          pill("Open"),
          pill("Bug"),
          pill("Design"),
          pill("API"),
        ]}
        meta={null}
      />
    );
    const row = pillRow(container);
    // The first three survive; the last two do not render as pills.
    expect(within(row).getByText("Critical")).toBeInTheDocument();
    expect(within(row).getByText("Open")).toBeInTheDocument();
    expect(within(row).getByText("Bug")).toBeInTheDocument();
    expect(within(row).queryByText("Design")).toBeNull();
    expect(within(row).queryByText("API")).toBeNull();

    // One chip, and only one, counts exactly the hidden pills.
    const chips = within(row).getAllByText(/^\+\d+$/);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent("+2");
  });

  it("keeps the hidden taxonomy reachable: the chip names it in title and to a screen reader", () => {
    const { container } = render(
      <IssueRowMeta
        pills={[pill("Critical"), pill("Open"), pill("Bug"), pill("Design"), pill("API")]}
        meta={null}
      />
    );
    const chip = within(pillRow(container)).getByText("+2");
    expect(chip).toHaveAttribute("title", expect.stringMatching(/Design.*API/));
    // Not sighted-only: a screen reader hears the count and the names.
    expect(chip).toHaveAttribute("aria-label", expect.stringMatching(/2.*Design.*API/));
  });

  it("matches the exported cap, so the page cannot drift from the test", () => {
    expect(MAX_VISIBLE_PILLS).toBe(3);
    const pills = Array.from({ length: MAX_VISIBLE_PILLS + 2 }, (_, i) => pill(`P${i}`));
    const { container } = render(<IssueRowMeta pills={pills} meta={null} />);
    const row = pillRow(container);
    // Three named pills plus the one overflow chip.
    expect(within(row).getByText("+2")).toBeInTheDocument();
    expect(within(row).getByText("P0")).toBeInTheDocument();
    expect(within(row).getByText("P2")).toBeInTheDocument();
    expect(within(row).queryByText("P3")).toBeNull();
  });

  it("renders no row when there is no taxonomy at all", () => {
    const { container } = render(<IssueRowMeta pills={[]} meta={null} />);
    expect(container.textContent).toBe("");
  });
});
