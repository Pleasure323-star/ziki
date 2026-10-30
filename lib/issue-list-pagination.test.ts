import { describe, expect, it } from "vitest";
import { buildPaginationUrl } from "@/lib/pagination";
import { issueListPaginationParams, type IssueListFilterValues } from "./issue-list-pagination";

const everything: IssueListFilterValues = {
  status: "open",
  mine: "assigned",
  q: "login",
  sort: "newest",
  milestone: "m1",
  tags: "bug,ui",
  platform: "cat1",
  area: "area1",
  stage: "reported",
  deleted: true,
  showDuplicates: true,
  showResolved: true,
  allProjects: true,
};

const nothing: IssueListFilterValues = {
  status: undefined,
  mine: null,
  q: undefined,
  sort: undefined,
  milestone: undefined,
  tags: undefined,
  platform: null,
  area: null,
  stage: null,
  deleted: false,
  showDuplicates: false,
  showResolved: false,
  allProjects: false,
};

describe("issueListPaginationParams (#967)", () => {
  it("carries every filter the list reads, area included", () => {
    expect(issueListPaginationParams(everything)).toEqual({
      status: "open",
      milestone: "m1",
      mine: "assigned",
      q: "login",
      tags: "bug,ui",
      platform: "cat1",
      area: "area1",
      stage: "reported",
      deleted: "true",
      duplicates: "show",
      resolved: "1",
      project: "all",
      sort: "newest",
    });
  });

  it("keeps the 'no area' choice, which is a real filter", () => {
    expect(issueListPaginationParams({ ...nothing, area: "none" })).toEqual({ area: "none" });
  });

  it("leaves out filters that are not set", () => {
    expect(issueListPaginationParams(nothing)).toEqual({});
    expect(issueListPaginationParams({ ...nothing, status: "open" })).toEqual({ status: "open" });
  });

  it("puts the area on the Next and Previous links", () => {
    const params = issueListPaginationParams({ ...nothing, area: "area1", sort: "newest" });
    const next = new URL(buildPaginationUrl("/issues", 2, params), "http://localhost");
    expect(next.pathname).toBe("/issues");
    expect(next.searchParams.get("area")).toBe("area1");
    expect(next.searchParams.get("page")).toBe("2");
    expect(next.searchParams.get("sort")).toBe("newest");
  });

  it("carries the workspace-wide ?project=all view, and only when chosen", () => {
    const params = issueListPaginationParams({ ...nothing, allProjects: true });
    expect(params.project).toBe("all");
    expect(issueListPaginationParams(nothing).project).toBeUndefined();
  });
});
