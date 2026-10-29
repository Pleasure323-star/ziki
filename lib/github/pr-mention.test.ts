import { describe, expect, it } from "vitest";
import { firstPullRequestLink } from "@/lib/github/pr-mention";

const PR = "https://github.com/Zedu-Endor/issue-tracker/pull/1230";

describe("pull request links", () => {
  it("picks the first pull request in a list of links", () => {
    expect(firstPullRequestLink([
      "https://github.com/Zedu-Endor/issue-tracker/issues/423",
      PR,
    ])).toBe(PR);
    expect(firstPullRequestLink(["https://github.com/Zedu-Endor/issue-tracker/issues/423"])).toBeNull();
  });
});
