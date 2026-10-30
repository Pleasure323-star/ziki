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
    expect(container.textContent).not.toContain("Requires confirmation…");
    expect(container.textContent).toContain("Confirmed by 2 people");
    expect(container.textContent).not.toMatch(/upvote|\(\d\/\d\)/);
    expect(container.querySelector("[title]")?.getAttribute("title")).toBe("Confirmed by 2 people so far");
  });

  it("says Confirmed once enough people confirmed it, still at Requires confirmation", () => {
    const { container } = render(<IssueRowStatus {...base} status="requires_confirmation" stage="confirming" botConfirmations={2} confirmed />);
    expect(container.textContent?.trim()).toBe("Confirmed");
    expect(container.textContent).not.toContain("Not confirmed");
    expect(container.querySelector("[title]")?.getAttribute("title")).toBe("Confirmed by 2 people");
  });

  it("says Ready for bids once confirmed", () => {
    expect(text(<IssueRowStatus {...base} stage="ready" />)).toBe("Ready for bids");
  });

  it("shows who is working, a hammer, and how long on a second line", () => {
    const since = new Date(Date.now() - (2 * 60 + 14) * 60_000);
    const { container } = render(<IssueRowStatus {...base} status="in_progress" work={{ person: "Cara QA", since }} />);
    expect(container.querySelector(".hammering")).not.toBeNull();
    expect(container.textContent).toContain("Cara QA");
    expect(container.textContent).toContain("is working on it");
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

  it("says why agents closed an issue (#close-superseded)", () => {
    expect(text(<IssueRowStatus {...base} status="closed" closeReason="superseded" />)).toBe("Closed · superseded");
  });

  it("labels the tested and accepted steps from the one status", () => {
    expect(text(<IssueRowStatus {...base} status="done" />)).toContain("Done");
    cleanup();
    expect(text(<IssueRowStatus {...base} status="ready_to_merge" />)).toContain("Ready to merge");
  });
});

describe("ConfirmationCountBadge", () => {
  it("shows just the count in the plain CountBadge while the issue is not confirmed", () => {
    const { getByTestId } = render(<ConfirmationCountBadge accepts={1} needed={2} confirmed={false} />);
    const badge = getByTestId("confirmation-count");
    expect(badge.textContent).toBe("1");
    expect(badge).toHaveAttribute("aria-label", "1 of 2 confirmations so far");
    expect(badge).toHaveAttribute("data-tone", "neutral");
    expect(badge).toHaveClass("border-zk-border");
    expect(badge).not.toHaveClass("border-dashed");
    expect(badge.querySelector("svg")).toBeNull();
  });

  it("turns green with a check once confirmed", () => {
    const { getByTestId } = render(<ConfirmationCountBadge accepts={2} needed={2} confirmed />);
    const badge = getByTestId("confirmation-count");
    expect(badge.textContent).toBe("2");
    expect(badge).toHaveAttribute("aria-label", "Confirmed: 2 of 2 confirmations");
    expect(badge).toHaveClass("bg-zk-ok-bg");
    expect(badge.querySelector("svg")).not.toBeNull();
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

  it("uses the compact chips to fit the status column", () => {
    const { container } = render(<IssueRowStatus {...base} status="resolved" mergePath={merged} />);
    expect(container.querySelector('[data-stage="dev"]')).toHaveClass("h-5");
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
    expect(container.querySelector("time")).toHaveAttribute("title", `Working since ${since.toLocaleString()}`);
  });
});
