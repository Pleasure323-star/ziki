import { describe, expect, it } from "vitest";
import { REPORT_SUMMARY_MAX_CHARS, REPORT_SUMMARY_MIN_CHARS, reportSummarySchema } from "./report-summary";

describe("reportSummarySchema (#report-summary)", () => {
  it("takes up to three plain lines, trimming each and dropping blank ones", () => {
    expect(reportSummarySchema.parse("  The login page drops the session.  ")).toBe("The login page drops the session.");
    expect(reportSummarySchema.parse("On phones the login button is hidden.\r\n\r\n  Tapping it opens the menu.\nPeople cannot sign in.")).toBe(
      "On phones the login button is hidden.\nTapping it opens the menu.\nPeople cannot sign in.",
    );
  });

  it("accepts the length limits exactly", () => {
    expect(reportSummarySchema.safeParse("x".repeat(REPORT_SUMMARY_MIN_CHARS)).success).toBe(true);
    expect(reportSummarySchema.safeParse("x".repeat(REPORT_SUMMARY_MAX_CHARS)).success).toBe(true);
  });

  it("refuses a summary that is too short", () => {
    const result = reportSummarySchema.safeParse("Login broken.");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/at least 20 characters/);
    expect(reportSummarySchema.safeParse("   ").success).toBe(false);
  });

  it("refuses a summary that is too long", () => {
    const result = reportSummarySchema.safeParse("x".repeat(REPORT_SUMMARY_MAX_CHARS + 1));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/at most 300 characters/);
  });

  it("refuses more than three lines", () => {
    const result = reportSummarySchema.safeParse("The first line.\nThe second line.\nThe third line.\nThe fourth line.");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/at most 3 lines/);
  });

  it.each([
    "## The login page drops the session",
    "The login page **drops** the session",
    "Run `pnpm dev` and the session drops",
    "> The login page drops the session",
    "See [the log](https://example.com) for the dropped session",
    "| Page | Result | the session drops",
  ])("refuses Markdown: %s", (summary) => {
    const result = reportSummarySchema.safeParse(summary);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(" ")).toMatch(/plain text, not Markdown/);
  });
});
