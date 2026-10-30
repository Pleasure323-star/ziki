import { describe, expect, it } from "vitest";
import {
  describePath,
  groupByPullRequest,
  latestMovement,
  mergePathOf,
  movementLabel,
  parseMergeBucket,
  type MergeMovement,
} from "./merge-history";

const at = new Date("2026-10-22T16:10:00Z");
const pr = (n: number) => `https://github.com/Zedu-Endor/issue-tracker/pull/${n}`;

describe("mergePathOf", () => {
  it("marks an issue without a PR as not linked", () => {
    const path = mergePathOf({ pullRequestUrl: null, status: "open", updatedAt: at });
    expect(path.steps).toEqual({ dev: "not_linked", staging: "pending", main: "pending" });
    expect(path.bucket).toBe("not_linked");
    expect(path.movements).toEqual([]);
  });

  it("treats a URL that is not a GitHub PR as not linked", () => {
    expect(mergePathOf({ pullRequestUrl: "https://example.com/x", status: "resolved", updatedAt: at }).bucket).toBe("not_linked");
  });

  it("puts a merged fix in dev only", () => {
    const path = mergePathOf({ pullRequestUrl: pr(1262), status: "resolved", updatedAt: at });
    expect(path.steps).toEqual({ dev: "merged", staging: "pending", main: "pending" });
    expect(path.bucket).toBe("dev");
    expect(path.movements[0]).toMatchObject({ stage: "dev", kind: "merged", prNumber: 1262, repo: "Zedu-Endor/issue-tracker" });
  });

  it("shows an unmerged PR as open into dev and in no stage tab", () => {
    const path = mergePathOf({ pullRequestUrl: pr(9), status: "ready_to_merge", updatedAt: at });
    expect(path.steps.dev).toBe("open");
    expect(path.bucket).toBeNull();
  });

  it("uses later movements for staging and main", () => {
    const later: MergeMovement[] = [
      { stage: "staging", kind: "merged", prNumber: 2041, prUrl: null, repo: "ziki-org/ziki", at },
      { stage: "main", kind: "opened", prNumber: 2047, prUrl: null, repo: "ziki-org/ziki", at },
    ];
    const path = mergePathOf({ pullRequestUrl: pr(1262), status: "resolved", updatedAt: at }, later);
    expect(path.steps).toEqual({ dev: "merged", staging: "merged", main: "open" });
    expect(path.bucket).toBe("staging");
    expect(movementLabel(latestMovement(path)!)).toBe("PR #2047 opened into main");
    expect(describePath(path)).toBe("Reached staging, pull request open into main");
  });

  it("counts a fix merged into main as in production", () => {
    const later: MergeMovement[] = [{ stage: "main", kind: "merged", prNumber: 2039, prUrl: null, repo: null, at }];
    expect(mergePathOf({ pullRequestUrl: pr(1), status: "resolved", updatedAt: at }, later).bucket).toBe("production");
  });
});

describe("describePath", () => {
  it.each([
    [{ pullRequestUrl: null, status: "open" }, "No pull request linked"],
    [{ pullRequestUrl: pr(1), status: "in_progress" }, "Pull request open into dev"],
    [{ pullRequestUrl: pr(1), status: "resolved" }, "Reached dev"],
  ])("%o → %s", (issue, expected) => {
    expect(describePath(mergePathOf({ ...issue, updatedAt: at }))).toBe(expected);
  });
});

describe("parseMergeBucket", () => {
  it("accepts the stage tabs and falls back to all", () => {
    expect(parseMergeBucket("staging")).toBe("staging");
    expect(parseMergeBucket("not_linked")).toBe("not_linked");
    expect(parseMergeBucket("prod")).toBe("all");
    expect(parseMergeBucket(undefined)).toBe("all");
  });
});

describe("groupByPullRequest", () => {
  it("groups issues under the PR that carried them, newest first", () => {
    const rows = [
      { id: "a", path: mergePathOf({ pullRequestUrl: pr(5), status: "resolved", updatedAt: new Date("2026-10-20") }) },
      { id: "b", path: mergePathOf({ pullRequestUrl: pr(7), status: "resolved", updatedAt: new Date("2026-10-25") }) },
      { id: "c", path: mergePathOf({ pullRequestUrl: pr(5), status: "resolved", updatedAt: new Date("2026-10-20") }) },
      { id: "d", path: mergePathOf({ pullRequestUrl: null, status: "open", updatedAt: at }) },
    ];
    const groups = groupByPullRequest(rows);
    expect(groups.map((g) => g.movement.prNumber)).toEqual([7, 5]);
    expect(groups[1].rows.map((r) => r.id)).toEqual(["a", "c"]);
  });
});
