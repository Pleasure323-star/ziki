import { describe, expect, it } from "vitest";
import { submitFailureMessage } from "./submit-error";

describe("submitFailureMessage", () => {
  it("tells an offline failure apart from an online one", () => {
    expect(submitFailureMessage(false)).not.toBe(submitFailureMessage(true));
  });

  it("names what was being submitted", () => {
    expect(submitFailureMessage(true, "comment")).toMatch(/comment/i);
  });
});
