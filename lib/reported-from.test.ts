import { describe, expect, it } from "vitest";
import { newIssueHref, reportedFromLine, safeReportedFrom } from "./reported-from";

describe("safeReportedFrom (#report-modal)", () => {
  it.each(["/issues", "/issues/42", "/dashboard", "/issues?status=open&page=2"])("keeps the in-app path %s", (path) => {
    expect(safeReportedFrom(path)).toBe(path);
  });

  it.each([
    ["an absolute URL", "https://evil.example/x"],
    ["a protocol-relative URL", "//evil.example"],
    ["a relative path", "issues"],
    ["whitespace", "/issues /x"],
    ["a control character", "/issues\u0000"],
    ["a backslash", "/\\evil.example"],
    ["the report page itself", "/issues/new"],
    ["the legacy report page", "/bugs/new?x=1"],
    ["something too long", `/${"a".repeat(300)}`],
    ["a non-string", 42],
  ])("drops %s", (_name, value) => {
    expect(safeReportedFrom(value)).toBeNull();
  });

  it("builds the description line and the report link", () => {
    expect(reportedFromLine("/issues/42")).toContain("/issues/42");
    expect(newIssueHref("/issues")).toBe("/issues/new?from=%2Fissues");
    expect(newIssueHref("https://evil.example")).toBe("/issues/new");
    expect(newIssueHref(null)).toBe("/issues/new");
  });
});
