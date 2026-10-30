import { describe, expect, it } from "vitest";
import {
  FINISHED_STATUS_FILTER,
  FINISHED_STATUS_VALUES,
  isDone,
  resultCountText,
  statusFilterValues,
  statusFilterWhere,
} from "./issue-state";

describe("isDone", () => {
  it("treats resolved and closed as finished", () => {
    expect(isDone("resolved")).toBe(true);
    expect(isDone("closed")).toBe(true);
  });

  it("treats anything still in flight as not done", () => {
    expect(isDone("open")).toBe(false);
    expect(isDone("in_progress")).toBe(false);
  });
});

describe("resultCountText", () => {
  it("names the status filter, so it is clear what is excluded", () => {
    expect(resultCountText(12, "open")).toBe("12 open issues");
    expect(resultCountText(1, "in_progress")).toBe("1 in progress issue");
  });

  it("calls the finished aggregate closed, matching the stat tile (#685)", () => {
    expect(resultCountText(43, FINISHED_STATUS_FILTER)).toBe("43 closed issues");
    expect(resultCountText(1, FINISHED_STATUS_FILTER)).toBe("1 closed issue");
  });

  it("stays plain with no status filter", () => {
    expect(resultCountText(32, null)).toBe("32 results");
    expect(resultCountText(1, null)).toBe("1 result");
  });
});

describe("statusFilterValues", () => {
  it("expands the finished token to resolved + closed (#685)", () => {
    expect(statusFilterValues(FINISHED_STATUS_FILTER)).toEqual([
      ...FINISHED_STATUS_VALUES,
    ]);
  });

  it("passes a real status through as a single value", () => {
    expect(statusFilterValues("open")).toEqual(["open"]);
    expect(statusFilterValues("resolved")).toEqual(["resolved"]);
  });

  it("returns null for no filter or an unknown value", () => {
    expect(statusFilterValues(undefined)).toBeNull();
    expect(statusFilterValues("")).toBeNull();
    expect(statusFilterValues("sideways")).toBeNull();
  });
});

describe("statusFilterWhere", () => {
  it("filters the finished token as an `in` over resolved and closed", () => {
    expect(statusFilterWhere(FINISHED_STATUS_FILTER)).toEqual({
      in: [...FINISHED_STATUS_VALUES],
    });
  });

  it("filters a real status as an equality, not an `in`", () => {
    expect(statusFilterWhere("open")).toBe("open");
    expect(statusFilterWhere("in_progress")).toBe("in_progress");
  });

  it("returns undefined when nothing should be filtered", () => {
    expect(statusFilterWhere(undefined)).toBeUndefined();
    expect(statusFilterWhere("sideways")).toBeUndefined();
  });
});
