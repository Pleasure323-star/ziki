// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmationCountBadge, IssueRowStatus } from "./issue-row-status";
import { ElapsedTime, formatElapsed } from "./elapsed-time";
import { renderToString } from "react-dom/server";
import { mergePathOf } from "@/lib/merge-history";

afterEach(() => cleanup());

const base = { status: "open", stage: undefined, botConfirmations: 0, work: null } as const;
const text = (ui: React.ReactElement) => render(ui).container.textContent?.replace(/\s+/g, " ").trim();

describe("IssueRowStatus", () => {

  it("says Not confirmed with the confirmers in the label, and no upvote count", () => {
    const { container } = render(<IssueRowStatus {...base} stage="confirming" botConfirmations={2} />);
    expect(container.textContent).toContain("Not confirmed");
    expect(container.textContent).toContain("2");
    expect(container.textContent).not.toMatch(/upvote/i);
  });

  it("says Confirmed once enough people confirmed it, still at Requires confirmation", () => {
    const { container } = render(<IssueRowStatus {...base} status="requires_confirmation" stage="confirming" botConfirmations={2} confirmed />);
    expect(container.textContent?.trim()).toBe("Confirmed");
    expect(container.textContent).not.toContain("Not confirmed");
  });

  it("says Ready for bids once confirmed", () => {
    expect(text(<IssueRowStatus {...base} stage="ready" />)).toBe("Ready for bids");
  });

  it("shows who is working and for how long", () => {
    const since = new Date(Date.now() - (2 * 60 + 14) * 60_000);
    const { container } = render(<IssueRowStatus {...base} status="in_progress" work={{ person: "Cara QA", since }} />);
    expect(container.textContent).toContain("Cara QA");
    expect(container.querySelector("time")?.textContent).toBe("2h 14m");
  });

  it("leaves the timer out when the start time is unknown", () => {
    const { container } = render(<IssueRowStatus {...base} status="in_progress" work={{ person: "Ada", since: null }} />);
    expect(container.querySelector("time")).toBeNull();
    expect(container.textContent).toContain("Ada");
  });

  it("labels finished issues", () => {
    expect(text(<IssueRowStatus {...base} status="resolved" />)).toBe("Live");
    cleanup();
    expect(text(<IssueRowStatus {...base} status="closed" />)).toBe("Closed");
  });

  it("says why an issue was closed (#close-reasons)", () => {
    expect(text(<IssueRowStatus {...base} status="closed" closeReason="superseded" />)).toBe("Closed: superseded");
    cleanup();
    expect(text(<IssueRowStatus {...base} status="closed" closeReason="not_reproducible" />)).toBe("Closed: not reproducible");
    cleanup();
    expect(text(<IssueRowStatus {...base} status="closed" closeReason="duplicate" />)).toBe("Closed: duplicate");
  });

  it("labels the tested and accepted steps from the one status", () => {
    expect(text(<IssueRowStatus {...base} status="done" />)).toContain("Done");
    cleanup();
    expect(text(<IssueRowStatus {...base} status="ready_to_merge" />)).toContain("Ready to merge");
  });
});

describe("ConfirmationCountBadge", () => {
  it("shows just the count, neutral, while the issue is not confirmed", () => {
    const { getByTestId } = render(<ConfirmationCountBadge accepts={1} needed={2} confirmed={false} />);
    const badge = getByTestId("confirmation-count");
    expect(badge.textContent).toBe("1");
    expect(badge).toHaveAttribute("aria-label", expect.stringMatching(/1 of 2/));
    expect(badge).toHaveAttribute("data-tone", "neutral");
  });

  it("says it is confirmed once confirmed", () => {
    const { getByTestId } = render(<ConfirmationCountBadge accepts={2} needed={2} confirmed />);
    const badge = getByTestId("confirmation-count");
    expect(badge.textContent).toBe("2");
    expect(badge).toHaveAttribute("aria-label", expect.stringMatching(/confirmed.*2 of 2/i));
  });
});

describe("IssueRowStatus merge path", () => {
  const merged = mergePathOf({
    pullRequestUrl: "https://github.com/Zedu-Endor/issue-tracker/pull/1262",
    status: "resolved",
    updatedAt: new Date("2026-10-22T16:10:00Z"),
  });

  it("shows the merge history chips instead of Live once the fix is merged", () => {
    const { container } = render(<IssueRowStatus {...base} status="resolved" mergePath={merged} />);
    const chips = Array.from(container.querySelectorAll("[data-stage]")).map((el) => `${el.textContent}:${el.getAttribute("data-state")}`);
    expect(chips).toEqual(["dev:merged", "staging:pending", "main:pending"]);
    expect(container.textContent).not.toContain("Live");
    expect(container.querySelector(".merge-path")).toHaveAttribute("aria-label", "Reached dev");
  });

  it("shows the live status, not the chips, for a reopened issue whose fix had merged", () => {
    const { container } = render(<IssueRowStatus {...base} status="in_progress" mergePath={merged} work={{ person: "Ada", since: null }} />);
    expect(container.querySelector("[data-stage]")).toBeNull();
    expect(container.textContent).toContain("Ada");
  });

  it("keeps the usual label when there is no merge path", () => {
    expect(text(<IssueRowStatus {...base} status="resolved" mergePath={null} />)).toBe("Live");
    cleanup();
    expect(text(<IssueRowStatus {...base} stage="ready" />)).toBe("Ready for bids");
  });
});

describe("formatElapsed", () => {
  it.each([
    [45_000, "45s"],
    [12 * 60_000, "12m"],
    [(2 * 60 + 14) * 60_000, "2h 14m"],
    [(3 * 24 + 4) * 3_600_000, "3d 4h"],
    [-5_000, "0s"],
  ])("%d ms → %s", (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });
});

describe("ElapsedTime tooltip", () => {
  const since = new Date("2026-10-20T10:00:00Z");

  it("leaves the tooltip out of the server render, so no server time zone leaks in", () => {
    expect(renderToString(<ElapsedTime since={since} />)).not.toContain("title=");
  });

  it("fills it in the browser with the viewer's local time", () => {
    const { container } = render(<ElapsedTime since={since} />);
    expect(container.querySelector("time")).toHaveAttribute("title", expect.stringContaining(since.toLocaleString()));
  });
});
