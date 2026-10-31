// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { IdeasList, type IdeaListRow } from "./ideas-list";

const row = (overrides: Partial<IdeaListRow>): IdeaListRow => ({
  id: "i1", number: 1, title: "An idea", score: 0, threshold: 3, createdAt: new Date("2026-10-30T00:00:00Z"),
  reporterName: "Ada", platform: null, verdicts: 0, good: 0, badVotes: 0, ...overrides,
});

afterEach(cleanup);

describe("Ideas list vote columns (#724)", () => {
  it("shows each idea's good and bad votes, zeros included", () => {
    render(<IdeasList ideas={[row({ id: "i1", good: 4, badVotes: 1 }), row({ id: "i2", number: 2, title: "Untouched" })]} />);
    const [first, second] = screen.getAllByTestId("idea-row");
    expect(within(first).getByTestId("idea-good-votes")).toHaveTextContent("4");
    expect(within(first).getByTestId("idea-bad-votes")).toHaveTextContent("1");
    expect(within(second).getByTestId("idea-good-votes")).toHaveTextContent("0");
    expect(within(second).getByTestId("idea-bad-votes")).toHaveTextContent("0");
  });

  it("sorts by a column from its heading, and the sorted heading goes back to score order", () => {
    const sortHref = (sort: "good" | "bad" | null) => (sort ? `/issues?ideaSort=${sort}` : "/issues");
    render(<IdeasList ideas={[row({})]} sort="bad" sortHref={sortHref} />);
    expect(screen.getByRole("link", { name: /Good/ })).toHaveAttribute("href", "/issues?ideaSort=good");
    const bad = screen.getByRole("link", { name: /Bad/ });
    expect(bad).toHaveAttribute("href", "/issues");
    expect(bad).toHaveAttribute("aria-sort", "descending");
  });
});
