import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  matchGlob,
  ruleMatches,
  assertApprovalOpen,
  checkApprovalOpen,
  decideApproval,
  createApprovalRule,
  deleteApprovalRule,
} from "./approvals";
import { IssueApiError } from "@/lib/agent-api/errors";

// Hoist mockDb
const db = vi.hoisted(() => ({
  bug: { findUnique: vi.fn(), findFirst: vi.fn() },
  approvalRule: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  issueApproval: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  membership: { findUnique: vi.fn(), findMany: vi.fn() },
  project: { findFirst: vi.fn() },
  projectAuditEvent: { create: vi.fn() },
  agentAuditEvent: { findFirst: vi.fn() },
  agent: { findFirst: vi.fn() },
  issueClaim: { create: vi.fn() },
  agentEvent: { create: vi.fn() },
  webhookSubscription: { findMany: vi.fn().mockResolvedValue([]) },
  webhookDelivery: { createMany: vi.fn() },
  $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(db)),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));

vi.mock("@/lib/github/merge-pr", () => ({
  mergeAcceptedFix: vi.fn(),
}));

vi.mock("@/lib/notify", () => ({
  notifyLater: vi.fn(),
}));

import { mergeAcceptedFix } from "@/lib/github/merge-pr";
import { notifyLater } from "@/lib/notify";

describe("Human approval rules and gates (#598)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("matchGlob", () => {
    it("matches exact files and extensions", () => {
      expect(matchGlob("package.json", "package.json")).toBe(true);
      expect(matchGlob("*.json", "package.json")).toBe(true);
      expect(matchGlob("*.json", "src/package.json")).toBe(false);
    });

    it("matches directory globs with **", () => {
      expect(matchGlob("app/(app)/billing/**", "app/(app)/billing/page.tsx")).toBe(true);
      expect(matchGlob("app/(app)/billing/**", "app/(app)/billing/actions/charge.ts")).toBe(true);
      expect(matchGlob("app/(app)/billing/**", "app/(app)/issues/page.tsx")).toBe(false);
      expect(matchGlob("lib/**", "lib/approvals.ts")).toBe(true);
    });

    it("matches wildcard globs like src/**/*.ts", () => {
      expect(matchGlob("src/**/*.ts", "src/index.ts")).toBe(true);
      expect(matchGlob("src/**/*.ts", "src/components/ui/button.ts")).toBe(true);
      expect(matchGlob("src/**/*.ts", "src/components/ui/button.tsx")).toBe(false);
    });
  });

  describe("ruleMatches", () => {
    it("matches by issue type name or id", () => {
      const rule = { stage: "before_merge", issueTypeId: "Design" };
      expect(ruleMatches(rule, { stage: "before_merge", issueTypeName: "Design" })).toBe(true);
      expect(ruleMatches(rule, { stage: "before_merge", issueTypeName: "design" })).toBe(true);
      expect(ruleMatches(rule, { stage: "before_merge", issueTypeId: "Design" })).toBe(true);
      expect(ruleMatches(rule, { stage: "before_merge", issueTypeName: "Bug" })).toBe(false);
      expect(ruleMatches(rule, { stage: "before_offer", issueTypeName: "Design" })).toBe(false);
    });

    it("matches by file glob from changed files in PR", () => {
      const rule = { stage: "before_merge", fileGlob: "app/(app)/billing/**" };
      expect(ruleMatches(rule, { stage: "before_merge", files: ["app/(app)/billing/invoice.tsx"] })).toBe(true);
      expect(ruleMatches(rule, { stage: "before_merge", files: ["app/(app)/issues/page.tsx"] })).toBe(false);
      expect(ruleMatches(rule, { stage: "before_merge", files: [] })).toBe(false);
    });
  });

  describe("assertApprovalOpen (stage: before_offer)", () => {
    const bug = {
      id: "bug-1",
      title: "Design revision",
      tenantId: "tenant-1",
      projectId: "proj-1",
      typeId: "type-design",
      type: { id: "type-design", name: "Design" },
    };

    it("passes without blocking when no rules match", async () => {
      db.bug.findUnique.mockResolvedValue(bug);
      db.approvalRule.findMany.mockResolvedValue([]);

      await expect(assertApprovalOpen("bug-1", "before_offer", { db: db as never })).resolves.toBeUndefined();
    });

    it("blocks with 409 waiting_for_human and creates approval when rule matches", async () => {
      db.bug.findUnique.mockResolvedValue(bug);
      db.approvalRule.findMany.mockResolvedValue([
        { id: "rule-1", stage: "before_offer", issueTypeId: "Design", fileGlob: null },
      ]);
      db.issueApproval.findFirst.mockResolvedValue(null);
      db.issueApproval.create.mockResolvedValue({ id: "appr-1", bugId: "bug-1", status: "pending" });
      db.membership.findMany.mockResolvedValue([{ userId: "admin-1" }]);

      let error: IssueApiError | null = null;
      try {
        await assertApprovalOpen("bug-1", "before_offer", { db: db as never });
      } catch (e) {
        error = e as IssueApiError;
      }

      expect(error).toBeInstanceOf(IssueApiError);
      expect(error?.status).toBe(409);
      expect(error?.message).toBe("waiting_for_human");
      expect(error?.body).toEqual({ approvalId: "appr-1" });

      expect(db.issueApproval.create).toHaveBeenCalledWith({
        data: {
          bugId: "bug-1",
          ruleId: "rule-1",
          stage: "before_offer",
          status: "pending",
        },
      });

      expect(db.agentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "approval.requested",
            tenantId: "tenant-1",
            bugId: "bug-1",
          }),
        }),
      );

      expect(notifyLater).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "approval_needed",
          recipientId: "admin-1",
          proposalId: "appr-1",
        }),
      );
    });

    it("passes when approval is already approved", async () => {
      db.bug.findUnique.mockResolvedValue(bug);
      db.approvalRule.findMany.mockResolvedValue([
        { id: "rule-1", stage: "before_offer", issueTypeId: "Design", fileGlob: null },
      ]);
      db.issueApproval.findFirst.mockResolvedValue({
        id: "appr-1",
        bugId: "bug-1",
        status: "approved",
      });

      await expect(assertApprovalOpen("bug-1", "before_offer", { db: db as never })).resolves.toBeUndefined();
    });
  });

  describe("checkApprovalOpen (stage: before_merge)", () => {
    const bug = {
      id: "bug-2",
      title: "Billing overhaul",
      tenantId: "tenant-1",
      projectId: "proj-1",
      typeId: "type-bug",
      type: { id: "type-bug", name: "Bug" },
    };

    it("returns allowed: false with approvalId when file glob rule matches", async () => {
      db.bug.findUnique.mockResolvedValue(bug);
      db.approvalRule.findMany.mockResolvedValue([
        { id: "rule-glob", stage: "before_merge", issueTypeId: null, fileGlob: "app/(app)/billing/**" },
      ]);
      db.issueApproval.findFirst.mockResolvedValue(null);
      db.issueApproval.create.mockResolvedValue({ id: "appr-2", bugId: "bug-2", status: "pending" });
      db.membership.findMany.mockResolvedValue([{ userId: "admin-1" }]);

      const result = await checkApprovalOpen("bug-2", "before_merge", {
        db: db as never,
        files: ["app/(app)/billing/stripe.ts"],
      });

      expect(result).toEqual({ allowed: false, approvalId: "appr-2", status: "pending" });
    });

    it("returns allowed: true when approval is granted", async () => {
      db.bug.findUnique.mockResolvedValue(bug);
      db.approvalRule.findMany.mockResolvedValue([
        { id: "rule-glob", stage: "before_merge", issueTypeId: null, fileGlob: "app/(app)/billing/**" },
      ]);
      db.issueApproval.findFirst.mockResolvedValue({
        id: "appr-2",
        bugId: "bug-2",
        status: "approved",
      });

      const result = await checkApprovalOpen("bug-2", "before_merge", {
        db: db as never,
        files: ["app/(app)/billing/stripe.ts"],
      });

      expect(result).toEqual({ allowed: true });
    });
  });

  describe("decideApproval", () => {
    it("rejects non-admins with 403", async () => {
      db.membership.findUnique.mockResolvedValue({ userId: "user-1", role: "member" });

      await expect(
        decideApproval("user-1", "tenant-1", "appr-1", "approved", { db: db as never }),
      ).rejects.toThrowError(new IssueApiError(403, "Only workspace owners and admins can decide approvals."));
    });

    it("approves, publishes approval.granted and audits for before_offer, leaving the issue Open for a manager's award (#bids-only-offers)", async () => {
      db.membership.findUnique.mockResolvedValue({ userId: "admin-1", role: "admin" });
      db.issueApproval.findFirst.mockResolvedValue({
        id: "appr-offer",
        stage: "before_offer",
        status: "pending",
        bugId: "bug-100",
        bug: {
          id: "bug-100",
          title: "Design issue",
          tenantId: "tenant-1",
          projectId: "proj-1",
          status: "open",
          assigneeId: null,
          pullRequestUrl: null,
        },
      });
      db.issueApproval.updateMany.mockResolvedValue({ count: 1 });

      const result = await decideApproval("admin-1", "tenant-1", "appr-offer", "approved", { db: db as never });
      expect(result.status).toBe("approved");

      // Verify audit
      expect(db.projectAuditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: "tenant-1",
          projectId: "proj-1",
          actorUserId: "admin-1",
          action: "approval.approved",
        }),
      });

      // Verify event
      expect(db.agentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "approval.granted",
            tenantId: "tenant-1",
            bugId: "bug-100",
          }),
        }),
      );

      // Nobody is offered the issue: it waits in Open for a manager agent to award a bid.
      expect(db.issueClaim.create).not.toHaveBeenCalled();
      expect(db.agentEvent.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: "claim.offered" }) }),
      );
    });

    it("approves, publishes approval.granted, and resumes merge automatically for before_merge", async () => {
      db.membership.findUnique.mockResolvedValue({ userId: "admin-1", role: "owner" });
      db.issueApproval.findFirst.mockResolvedValue({
        id: "appr-merge",
        stage: "before_merge",
        status: "pending",
        bugId: "bug-200",
        bug: {
          id: "bug-200",
          title: "Billing issue",
          tenantId: "tenant-1",
          projectId: "proj-1",
          status: "resolved",
          assigneeId: "user-dev",
          pullRequestUrl: "https://github.com/zedu/web/pull/42",
        },
      });
      db.issueApproval.updateMany.mockResolvedValue({ count: 1 });

      db.agentAuditEvent.findFirst.mockResolvedValue({
        agent: {
          id: "merger-1",
          name: "merger-bot",
          ownerUserId: "owner-1",
          tenantId: "tenant-1",
        },
      });

      await decideApproval("admin-1", "tenant-1", "appr-merge", "approved", { db: db as never });

      // Verify merge was resumed automatically
      expect(mergeAcceptedFix).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "merger-1", level: "manager" }),
        "bug-200",
        expect.anything(),
      );
    });

    it("lets only one of two simultaneous decisions win (#537)", async () => {
      db.membership.findUnique.mockResolvedValue({ userId: "admin-1", role: "admin" });
      db.issueApproval.findFirst.mockResolvedValue({
        id: "appr-race",
        stage: "before_offer",
        status: "pending",
        bugId: "bug-race",
        bug: {
          id: "bug-race",
          title: "Race",
          tenantId: "tenant-1",
          projectId: "proj-1",
          status: "open",
          assigneeId: null,
          pullRequestUrl: null,
        },
      });
      // Another admin's decision committed first; the conditional write loses.
      db.issueApproval.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        decideApproval("admin-1", "tenant-1", "appr-race", "approved", { db: db as never }),
      ).rejects.toThrowError(new IssueApiError(409, "This approval has already been decided."));

      expect(db.projectAuditEvent.create).not.toHaveBeenCalled();
      expect(db.issueClaim.create).not.toHaveBeenCalled();
    });
  });

  describe("ApprovalRule management", () => {
    it("creates an approval rule and audits it", async () => {
      db.membership.findUnique.mockResolvedValue({ role: "admin" });
      db.project.findFirst.mockResolvedValue({ id: "proj-1" });
      db.approvalRule.create.mockResolvedValue({
        id: "rule-1",
        projectId: "proj-1",
        stage: "before_merge",
        issueTypeId: "Design",
      });

      const rule = await createApprovalRule(
        "admin-1",
        "tenant-1",
        "proj-1",
        { stage: "before_merge", issueTypeId: "Design" },
        db as never,
      );

      expect(rule.id).toBe("rule-1");
      expect(db.projectAuditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: "tenant-1",
          projectId: "proj-1",
          actorUserId: "admin-1",
          action: "approval_rule.created",
        }),
      });
    });

    it("deletes an approval rule and audits it", async () => {
      db.membership.findUnique.mockResolvedValue({ role: "admin" });
      db.approvalRule.findUnique.mockResolvedValue({
        id: "rule-1",
        projectId: "proj-1",
        project: { tenantId: "tenant-1" },
      });

      const result = await deleteApprovalRule("admin-1", "tenant-1", "rule-1", db as never);
      expect(result.ok).toBe(true);
      expect(db.approvalRule.delete).toHaveBeenCalledWith({ where: { id: "rule-1" } });
      expect(db.projectAuditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: "tenant-1",
          projectId: "proj-1",
          actorUserId: "admin-1",
          action: "approval_rule.deleted",
        }),
      });
    });
  });
});
