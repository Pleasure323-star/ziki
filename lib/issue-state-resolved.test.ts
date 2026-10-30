import { describe, expect, it } from "vitest";
import { defaultStatusWhere, LIVE_STATUS_VALUES, parseShowResolved } from "./issue-state";

describe("hiding resolved issues by default (#1058)", () => {
  it("shows live work only, unless resolved issues are asked for", () => {
    expect(defaultStatusWhere(false)).toEqual({ in: ["requires_confirmation", "open", "in_progress", "delivered", "done", "ready_to_merge"] });
    expect(defaultStatusWhere(true)).toBeUndefined();
    expect(LIVE_STATUS_VALUES).not.toContain("resolved");
  });

  it("reads ?resolved=1 and nothing else", () => {
    expect(parseShowResolved("1")).toBe(true);
    expect(parseShowResolved(["1", "0"])).toBe(true);
    for (const value of [undefined, null, "", "0", "true", "yes"]) {
      expect(parseShowResolved(value as string | undefined)).toBe(false);
    }
  });
});
