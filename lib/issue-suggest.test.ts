import { describe, expect, it } from "vitest";
import {
  MAX_SUGGEST_LENGTH,
  normalizeSuggestQuery,
  shouldSuggest,
} from "./issue-suggest";

describe("normalizeSuggestQuery", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeSuggestQuery("  login   button  ")).toBe("login button");
  });

  it("handles missing values", () => {
    expect(normalizeSuggestQuery(null)).toBe("");
    expect(normalizeSuggestQuery(undefined)).toBe("");
  });

  it("caps very long queries", () => {
    expect(normalizeSuggestQuery("a".repeat(MAX_SUGGEST_LENGTH + 50))).toHaveLength(
      MAX_SUGGEST_LENGTH,
    );
  });
});

describe("shouldSuggest", () => {
  it("waits for a meaningful query", () => {
    expect(shouldSuggest("a")).toBe(false);
    expect(shouldSuggest("ab")).toBe(true);
    expect(shouldSuggest("")).toBe(false);
  });
});
