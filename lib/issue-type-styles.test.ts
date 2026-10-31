import { describe, expect, it } from "vitest";
import {
  getIssueTypeBadgeClass,
  issueTypeBadgeClass,
} from "./issue-type-styles";

describe("issue-type-styles (#145)", () => {
  it("returns specific classes for default types without Prisma dependencies", () => {
    expect(getIssueTypeBadgeClass("Marketing")).toBe(
      issueTypeBadgeClass.Marketing,
    );
    expect(getIssueTypeBadgeClass("Design")).toBe(issueTypeBadgeClass.Design);
    expect(getIssueTypeBadgeClass("Fix")).toBe(issueTypeBadgeClass.Fix);
    expect(getIssueTypeBadgeClass("Feat")).toBe(issueTypeBadgeClass.Feat);
  });

  it("returns fallback class for unknown / custom types", () => {
    expect(getIssueTypeBadgeClass("UnknownType")).toBeTruthy();
    expect(getIssueTypeBadgeClass("UnknownType")).toBe(getIssueTypeBadgeClass("AnotherCustomType"));
  });
});
