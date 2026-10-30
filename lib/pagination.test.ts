import { describe, expect, it } from "vitest";
import {
  buildPaginationUrl,
  calculatePagination,
  getPaginationRange,
  parsePage,
} from "./pagination";

describe("parsePage", () => {
  it("defaults to 1 for undefined or empty input", () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage("")).toBe(1);
  });

  it("defaults to 1 for invalid or non-numeric input", () => {
    expect(parsePage("abc")).toBe(1);
    expect(parsePage("-5")).toBe(1);
    expect(parsePage(0)).toBe(1);
  });

  it("parses valid page numbers", () => {
    expect(parsePage("3")).toBe(3);
    expect(parsePage(5)).toBe(5);
  });

  it("handles repeated query parameter string array", () => {
    expect(parsePage(["3", "2"])).toBe(3);
    expect(parsePage([])).toBe(1);
  });
});

describe("calculatePagination", () => {
  it("handles zero total count", () => {
    const result = calculatePagination({ totalCount: 0, pageSize: 25 });
    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(1);
    expect(result.skip).toBe(0);
    expect(result.take).toBe(25);
    expect(result.hasPrev).toBe(false);
    expect(result.hasNext).toBe(false);
    expect(result.from).toBe(0);
    expect(result.to).toBe(0);
  });

  it("handles single page with less than pageSize items", () => {
    const result = calculatePagination({ totalCount: 15, pageSize: 25 });
    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(1);
    expect(result.skip).toBe(0);
    expect(result.hasPrev).toBe(false);
    expect(result.hasNext).toBe(false);
    expect(result.from).toBe(1);
    expect(result.to).toBe(15);
  });

  it("calculates multi-page bounds accurately", () => {
    const result = calculatePagination({
      page: 2,
      pageSize: 25,
      totalCount: 70,
    });
    expect(result.page).toBe(2);
    expect(result.totalPages).toBe(3);
    expect(result.skip).toBe(25);
    expect(result.take).toBe(25);
    expect(result.hasPrev).toBe(true);
    expect(result.hasNext).toBe(true);
    expect(result.prevPage).toBe(1);
    expect(result.nextPage).toBe(3);
    expect(result.from).toBe(26);
    expect(result.to).toBe(50);
  });

  it("clamps requested page that exceeds totalPages", () => {
    const result = calculatePagination({
      page: 99,
      pageSize: 25,
      totalCount: 30,
    });
    expect(result.page).toBe(2);
    expect(result.skip).toBe(25);
    expect(result.hasPrev).toBe(true);
    expect(result.hasNext).toBe(false);
    expect(result.from).toBe(26);
    expect(result.to).toBe(30);
  });
});

describe("buildPaginationUrl", () => {
  it("omits page param when on page 1", () => {
    expect(buildPaginationUrl("/issues", 1, { q: "login" })).toBe("/issues?q=login");
  });

  it("includes page param when > 1", () => {
    expect(buildPaginationUrl("/issues", 2, { q: "login" })).toBe(
      "/issues?q=login&page=2",
    );
  });

  it("preserves multiple query params and omits empty/null params", () => {
    expect(
      buildPaginationUrl("/issues", 3, {
        q: "test",
        status: "OPEN",
        area: "",
        empty: null,
      }),
    ).toBe("/issues?q=test&status=OPEN&page=3");
  });

  it("preserves sort query param alongside filters across pagination URLs", () => {
    expect(
      buildPaginationUrl("/issues", 2, {
        q: "crash",
        status: "open",
        sort: "importance",
      }),
    ).toBe("/issues?q=crash&status=open&sort=importance&page=2");
  });

  it("returns base path when no query params and page is 1", () => {
    expect(buildPaginationUrl("/issues", 1, {})).toBe("/issues");
  });
});

describe("getPaginationRange", () => {
  it("returns all pages when totalPages <= 7", () => {
    expect(getPaginationRange(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("shows right ellipsis when near start of large range", () => {
    expect(getPaginationRange(2, 10)).toEqual([1, 2, 3, 4, 5, "...", 10]);
  });

  it("shows left ellipsis when near end of large range", () => {
    expect(getPaginationRange(9, 10)).toEqual([1, "...", 6, 7, 8, 9, 10]);
  });

  it("shows both ellipses when in middle of large range", () => {
    expect(getPaginationRange(5, 10)).toEqual([1, "...", 4, 5, 6, "...", 10]);
  });
});

