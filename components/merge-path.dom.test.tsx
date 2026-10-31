// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MergePathChips } from "./merge-path";
import { mergePathOf } from "@/lib/merge-history";

afterEach(() => cleanup());

const at = new Date("2026-10-22T16:10:00Z");
const states = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("[data-stage]")).map((el) => `${el.textContent}:${el.getAttribute("data-state")}`);

describe("MergePathChips", () => {
  it("shows dev merged and the rest not reached", () => {
    const path = mergePathOf({ pullRequestUrl: "https://github.com/o/r/pull/1", status: "resolved", updatedAt: at });
    const { container } = render(<MergePathChips path={path} />);
    expect(states(container)).toEqual(["dev:merged", "staging:pending", "main:pending"]);
    expect(container.querySelector(".merge-path")).toHaveAttribute("aria-label", "Reached dev");
  });

  it("warns on dev when no PR is linked", () => {
    const { container } = render(<MergePathChips path={mergePathOf({ pullRequestUrl: null, status: "open", updatedAt: at })} />);
    expect(states(container)[0]).toBe("dev:not_linked");
  });

});
