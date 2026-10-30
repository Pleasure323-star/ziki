// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ProjectApprovalRulesSection } from "./approval-rules";
import { createApprovalRuleAction, deleteApprovalRuleAction } from "@/app/(app)/projects/actions";

vi.mock("@/lib/auth-helpers", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/tenant-context", () => ({
  currentTenantIdFor: vi.fn(),
  NO_TENANT_MESSAGE: "No tenant",
}));

vi.mock("@/lib/approvals", () => ({
  createApprovalRule: vi.fn(),
  deleteApprovalRule: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { requireUser } from "@/lib/auth-helpers";
import { currentTenantIdFor } from "@/lib/tenant-context";
import { createApprovalRule, deleteApprovalRule } from "@/lib/approvals";
import { revalidatePath } from "next/cache";

describe("ProjectApprovalRulesSection and actions (#598)", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe("UI rendering", () => {
    it("renders empty state when no rules exist", () => {
      render(
        <ProjectApprovalRulesSection
          projectId="proj-1"
          slug="web"
          rules={[]}
          issueTypes={[{ id: "type-1", name: "Design" }]}
        />,
      );

      expect(screen.getByText("Human approval rules")).toBeInTheDocument();
      expect(
        screen.getByText(/No approval rules configured for this project yet/i),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Add rule" })).toBeInTheDocument();
    });

    it("renders existing rules with stage, type and file glob, and no severity", () => {
      const rules = [
        {
          id: "rule-1",
          stage: "before_merge",
          issueTypeId: "type-1",
          fileGlob: "app/(app)/billing/**",
          issueType: { id: "type-1", name: "Design" },
        },
        {
          id: "rule-2",
          stage: "before_offer",
          issueTypeId: null,
          fileGlob: null,
          issueType: null,
        },
      ];

      render(
        <ProjectApprovalRulesSection
          projectId="proj-1"
          slug="web"
          rules={rules}
          issueTypes={[{ id: "type-1", name: "Design" }]}
        />,
      );

      expect(screen.getAllByText("Before merge").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Design").length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText(/Severity/i)).not.toBeInTheDocument();
      expect(screen.getByText("Files: app/(app)/billing/**")).toBeInTheDocument();

      expect(screen.getAllByText("Before offer").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("Any type")).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(2);
    });
  });

  describe("Server actions", () => {
    it("createApprovalRuleAction creates a rule and revalidates", async () => {
      vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);
      vi.mocked(currentTenantIdFor).mockResolvedValue("tenant-1");

      const formData = new FormData();
      formData.set("projectId", "proj-1");
      formData.set("slug", "web");
      formData.set("stage", "before_merge");
      formData.set("issueTypeId", "type-design");
      formData.set("fileGlob", "app/(app)/billing/**");

      await createApprovalRuleAction(formData);

      expect(createApprovalRule).toHaveBeenCalledWith(
        "user-1",
        "tenant-1",
        "proj-1",
        {
          stage: "before_merge",
          issueTypeId: "type-design",
          fileGlob: "app/(app)/billing/**",
        },
      );
      expect(revalidatePath).toHaveBeenCalledWith("/projects/web/settings");
    });

    it("deleteApprovalRuleAction deletes a rule and revalidates", async () => {
      vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);
      vi.mocked(currentTenantIdFor).mockResolvedValue("tenant-1");

      const formData = new FormData();
      formData.set("ruleId", "rule-123");
      formData.set("slug", "web");

      await deleteApprovalRuleAction(formData);

      expect(deleteApprovalRule).toHaveBeenCalledWith("user-1", "tenant-1", "rule-123");
      expect(revalidatePath).toHaveBeenCalledWith("/projects/web/settings");
    });
  });
});
