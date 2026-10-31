import { describe, expect, it } from "vitest";
import {
  canDeleteIssueType,
  getIssueTypeBadgeClass,
  issueTypeBadgeClass,
  issueTypeInputSchema,
} from "./issue-types";

describe("issue-types helpers", () => {
  describe("canDeleteIssueType", () => {
    it("allows deletion when no issues are associated", () => {
      const result = canDeleteIssueType(0);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("prevents deletion when issues are using the type (singular)", () => {
      const result = canDeleteIssueType(1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("in use by 1 issue");
    });

    it("prevents deletion when multiple issues are using the type (plural)", () => {
      const result = canDeleteIssueType(5);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("in use by 5 issues");
    });
  });

  describe("issueTypeInputSchema", () => {
    it("accepts valid issue type names", () => {
      const parsed = issueTypeInputSchema.safeParse({
        name: "Security",
        description: "Vulnerabilities and security hardening",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.name).toBe("Security");
        expect(parsed.data.isActive).toBe(true);
      }
    });

    it("rejects names shorter than 2 characters", () => {
      const parsed = issueTypeInputSchema.safeParse({
        name: "A",
      });
      expect(parsed.success).toBe(false);
    });

    it("trims whitespace from name", () => {
      const parsed = issueTypeInputSchema.safeParse({
        name: "  DevOps  ",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.name).toBe("DevOps");
      }
    });

    it("accepts explicit isActive flag", () => {
      const parsed = issueTypeInputSchema.safeParse({
        name: "Deprecated",
        isActive: false,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.isActive).toBe(false);
      }
    });
  });

  describe("getIssueTypeBadgeClass", () => {
    it("returns specific classes for default types", () => {
      expect(getIssueTypeBadgeClass("Marketing")).toBe(
        issueTypeBadgeClass.Marketing,
      );
      expect(getIssueTypeBadgeClass("Design")).toBe(
        issueTypeBadgeClass.Design,
      );
      expect(getIssueTypeBadgeClass("Fix")).toBe(issueTypeBadgeClass.Fix);
      expect(getIssueTypeBadgeClass("Feat")).toBe(issueTypeBadgeClass.Feat);
    });

    it("returns fallback class for custom types", () => {
      expect(getIssueTypeBadgeClass("CustomType")).toBeTruthy();
      expect(getIssueTypeBadgeClass("CustomType")).toBe(getIssueTypeBadgeClass("OtherCustomType"));
    });
  });
});

