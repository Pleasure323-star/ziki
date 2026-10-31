// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmationCountBadge, IssueRowStatus } from "./issue-row-status";
import { ElapsedTime, formatElapsed } from "./elapsed-time";
import { renderToString } from "react-dom/server";
import { mergePathOf } from "@/lib/merge-history";

afterEach(() => cleanup());

const base = { substatus: "open", stage: undefined, botConfirmations: 0, work: null } as const;
const text = (ui: React.ReactElement) => render(ui).container.textContent?.replace(/\s+/g, " ").trim();

describe("IssueRowStatus", () => {

  it("says Requires confirmation with the confirmers in the label, and no upvote count", () => {
    const { container } = render(<IssueRowStatus {...base} substatus="requires_confirmation" stage="confirming" botConfirmations={2} />);
    expect(container.textContent).toContain("Requires confirmation");
    expect(container.textContent).toContain("2");
    expect(container.textContent).not.toMatch(/upvote/i);
  });

  it("says Confirmed once enough people confirmed it, still at Requires confirmation", () => {
    const { container } = render(<IssueRowStatus {...base} substatus="requires_confirmation" stage="confirming" botConfirmations={2} confirmed />);
    expect(container.textContent?.trim()).toBe("Confirmed");
    expect(container.textContent).not.toContain("Requires confirmation");
  });

  it("says Ready for bids once confirmed", () => {
    expect(text(<IssueRowStatus {...base} stage="ready" />)).toBe("Ready for bids");
  });

  it("shows who is working and for how long", () => {
    const since = new Date(Date.now() - (2 * 60 + 14) * 60_000);
    const { container } = render(<IssueRowStatus {...base} substatus="in_progress" work={{ person: "Cara QA", since }} />);
    expect(container.textContent).toContain("Cara QA");
    expect(container.querySelector("time")?.textContent).toBe("2h 14m");
  });

  it("leaves the timer out when the start time is unknown", () => {
    const { container } = render(<IssueRowStatus {...base} substatus="in_progress" work={{ person: "Ada", since: null }} />);
    expect(container.querySelector("time")).toBeNull();
    expect(container.textContent).toContain("Ada");
  });

  it("labels finished issues, a Live one by where it is deployed", () => {
    expect(text(<IssueRowStatus {...base} substatus="on_prod" />)).toBe("On prod");
    cleanup();
    expect(text(<IssueRowStatus {...base} substatus="closed" />)).toBe("Closed");
  });

  it("says why an issue was closed (#close-reasons)", () => {
    expect(text(<IssueRowStatus {...base} substatus="closed" closeReason="superseded" />)).toBe("Closed: superseded");
    cleanup();
    expect(text(<IssueRowStatus {...base} substatus="closed" closeReason="not_reproducible" />)).toBe("Closed: not reproducible");
    cleanup();
    expect(text(<IssueRowStatus {...base} substatus="closed" closeReason="duplicate" />)).toBe("Closed: duplicate");
  });

  it("labels the steps within Done and Merge from the substatus (#substatus)", () => {
    expect(text(<IssueRowStatus {...base} substatus="requires_review" />)).toContain("Requires review");
    cleanup();
    expect(text(<IssueRowStatus {...base} substatus="accepted" />)).toContain("Accepted");
    cleanup();
    expect(text(<IssueRowStatus {...base} substatus="merge_error" />)).toContain("Merge error");
    cleanup();
    expect(text(<IssueRowStatus {...base} substatus="ready_to_merge" />)).toContain("Ready to merge");
  });
});

describe("ConfirmationCountBadge", () => {
  it("shows the confirms and the rejects, neutral, while the issue is not confirmed", () => {
    const { getByTestId } = render(<ConfirmationCountBadge accepts={1} rejects={2} needed={2} confirmed={false} />);
    expect(getByTestId("confirmation-accepts").textContent).toBe("1");
    expect(getByTestId("confirmation-rejects").textContent).toBe("2");
    expect(getByTestId("confirmation-count")).toHaveAttribute("data-tone", "neutral");
  });

  it("turns green once confirmed", () => {
    const { getByTestId } = render(<ConfirmationCountBadge accepts={2} rejects={0} needed={2} confirmed />);
    expect(getByTestId("confirmation-accepts").textContent).toBe("2");
    expect(getByTestId("confirmation-count")).toHaveAttribute("data-tone", "ok");
  });
});

describe("IssueRowStatus merge path", () => {
  const merged = mergePathOf({
    pullRequestUrl: "https://github.com/Zedu-Endor/issue-tracker/pull/1262",
    status: "resolved",
    updatedAt: new Date("2026-10-22T16:10:00Z"),
  });

  it("shows the merge history chips instead of Live once the fix is merged", () => {
    const { container } = render(<IssueRowStatus {...base} substatus="on_prod" mergePath={merged} />);
    const chips = Array.from(container.querySelectorAll("[data-stage]")).map((el) => `${el.textContent}:${el.getAttribute("data-state")}`);
    expect(chips).toEqual(["dev:merged", "staging:pending", "main:pending"]);
    expect(container.textContent).not.toContain("Live");
    expect(container.querySelector(".merge-path")).toHaveAttribute("aria-label", "Reached dev");
  });

  it("shows the live status, not the chips, for a reopened issue whose fix had merged", () => {
    const { container } = render(<IssueRowStatus {...base} substatus="in_progress" mergePath={merged} work={{ person: "Ada", since: null }} />);
    expect(container.querySelector("[data-stage]")).toBeNull();
    expect(container.textContent).toContain("Ada");
  });

  it("keeps the usual label when there is no merge path", () => {
    expect(text(<IssueRowStatus {...base} substatus="on_prod" mergePath={null} />)).toBe("On prod");
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
