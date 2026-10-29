import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatStructuredDescription,
  inferPlatform,
  inferType,
  structureIssue,
} from "./structure";
import type { AgentContext } from "@/lib/agents/require-agent";

const txMock = {
  bug: {
    update: vi.fn().mockResolvedValue({ id: "bug-1" }),
  },
  issueConfirmation: {
    upsert: vi.fn().mockResolvedValue({ id: "val-1" }),
  },
  bugActivity: {
    create: vi.fn().mockResolvedValue({ id: "act-1" }),
  },
  agentEvent: {
    create: vi.fn().mockResolvedValue({ id: "event-1" }),
  },
  agentAuditEvent: {
    create: vi.fn().mockResolvedValue({ id: "audit-1" }),
  },
  webhookSubscription: {
    findMany: vi.fn().mockResolvedValue([]),
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bug: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    category: {
      findMany: vi.fn(),
    },
    issueType: {
      findMany: vi.fn(),
    },
    issueConfirmation: {
      upsert: vi.fn(),
    },
    bugActivity: {
      create: vi.fn(),
    },
    agentEvent: {
      create: vi.fn(),
    },
    agentAuditEvent: {
      create: vi.fn(),
    },
    webhookSubscription: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      return callback(txMock);
    }),
  },
}));

vi.mock("@/lib/agent-api/issues", () => ({
  IssueApiError: class extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
  readAgentIssue: vi.fn().mockResolvedValue({
    id: "bug-1",
    title: "Structured Title",
    description: "Structured description",
    categoryId: "cat-mobile",
    typeId: "type-bug",
  }),
}));

vi.mock("@/lib/agent-api/create-policy", () => ({
  findSimilarIssues: vi.fn().mockResolvedValue([
    {
      id: "bug-existing",
      number: 10,
      title: "Similar login crash",
      status: "open",
      voteCount: 2,
    },
  ]),
}));

vi.mock("@/lib/agents/audit", () => ({
  audit: vi.fn().mockResolvedValue({ id: "audit-1" }),
}));

vi.mock("@/lib/agent-api/events", () => ({
  publish: vi.fn().mockResolvedValue({ id: "event-1" }),
}));

import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/agents/audit";
import { publish } from "@/lib/agent-api/events";

const mockAgent: AgentContext = {
  agentId: "agent-1",
  keyId: "key-1",
  tenantId: "tenant-1",
  ownerId: "user-1",
  level: "working",
  name: "TriageBot",
  burst: true,
};

describe("Agent structuring heuristics", () => {
  const categories = [
    { id: "cat-mobile", name: "Mobile" },
    { id: "cat-web", name: "Web" },
    { id: "cat-desktop", name: "Desktop" },
  ];

  const types = [
    { id: "type-bug", name: "Bug" },
    { id: "type-feature", name: "Feature" },
  ];

  it("infers platform from keyword associations", () => {
    expect(inferPlatform("App crashes on iPhone 15 Pro", categories)).toBe("cat-mobile");
    expect(inferPlatform("Chrome browser throws blank screen", categories)).toBe("cat-web");
    expect(inferPlatform("Windows installer fails to start", categories)).toBe("cat-desktop");
    expect(inferPlatform("Something broke here", categories)).toBeNull();
  });

  it("infers issue type from problem or request keywords", () => {
    expect(inferType("Critical crash on startup", types)).toBe("type-bug");
    expect(inferType("Feature request: add export to CSV", types)).toBe("type-feature");
    expect(inferType("General observation", types)).toBeNull();
  });

  it("formats structured description markdown cleanly", () => {
    const formatted = formatStructuredDescription({
      stepsToReproduce: "1. Open app\n2. Click login",
      expectedBehavior: "User is logged in",
      actualBehavior: "App crashes",
      environment: "iOS 18, Safari",
    });

    expect(formatted).toContain("### Steps to Reproduce\n1. Open app\n2. Click login");
    expect(formatted).toContain("### Expected Behavior\nUser is logged in");
    expect(formatted).toContain("### Actual Behavior\nApp crashes");
    expect(formatted).toContain("### Environment\niOS 18, Safari");
  });
});

const db = prisma as unknown as {
  bug: { findFirst: ReturnType<typeof vi.fn> };
  category: { findMany: ReturnType<typeof vi.fn> };
  issueType: { findMany: ReturnType<typeof vi.fn> };
};

describe("structureIssue execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.bug.findFirst.mockReset();
    db.category.findMany.mockResolvedValue([
      { id: "cat-mobile", name: "Mobile" },
      { id: "cat-web", name: "Web" },
    ]);
    db.issueType.findMany.mockResolvedValue([
      { id: "type-bug", name: "Bug" },
      { id: "type-feature", name: "Feature" },
    ]);
  });

  it.each(["working", "manager", "merger"] as const)("lets the owner's %s format a report without self-validating", async (level) => {
    db.bug.findFirst.mockResolvedValue({ id: "bug-1", title: "Report", description: "Original description", categoryId: null, typeId: null, duplicateOfId: null, reporterId: "user-1", beneficiaryUserId: "user-1", createdByAgent: { ownerUserId: "user-1" }, claims: [] });
    const result = await structureIssue({ ...mockAgent, level }, "proj-1", "bug-1", { description: "Clarified reproduction details", checkDuplicates: false });
    expect(result.ok).toBe(true);
    expect(txMock.issueConfirmation.upsert).not.toHaveBeenCalled();
  });

  it.each(["manager", "merger"] as const)("blocks an owner's %s from marking their report as a duplicate", async (level) => {
    db.bug.findFirst.mockResolvedValueOnce({ id: "bug-1", title: "Report", description: "Original description", reporterId: "user-1", beneficiaryUserId: "another-person", createdByAgent: { ownerUserId: "user-1" }, claims: [] }).mockResolvedValueOnce({ id: "canonical" });
    await expect(structureIssue({ ...mockAgent, level }, "proj-1", "bug-1", { duplicateOfId: "canonical" })).rejects.toMatchObject({ status: 403 });
    expect(txMock.bug.update).not.toHaveBeenCalled();
    expect(txMock.issueConfirmation.upsert).not.toHaveBeenCalled();
  });

  it("lets an independent working agent mark a report as a duplicate through the structuring endpoint", async () => {
    db.bug.findFirst.mockResolvedValueOnce({ id: "bug-1", title: "Report", description: "Original description", reporterId: "another-person", beneficiaryUserId: "another-person", createdByAgent: null, claims: [] }).mockResolvedValueOnce({ id: "canonical" });
    const result = await structureIssue(mockAgent, "proj-1", "bug-1", { duplicateOfId: "canonical", checkDuplicates: false });
    expect(result.ok).toBe(true);
    expect(txMock.bug.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ duplicateOfId: "canonical" }) }));
    // The issue's duplicateOfId marks it; structuring writes no confirmation entry (#issue-confirmations).
    expect(txMock.issueConfirmation.upsert).not.toHaveBeenCalled();
  });

  it("writes no confirmation entry when an independent agent structures a report", async () => {
    db.bug.findFirst.mockResolvedValue({ id: "bug-1", title: "Report", description: "Original description", categoryId: null, typeId: null, duplicateOfId: null, reporterId: "another-person", beneficiaryUserId: "another-person", createdByAgent: null, claims: [] });
    await structureIssue({ ...mockAgent, level: "working" }, "proj-1", "bug-1", { description: "Structured description", checkDuplicates: false });
    expect(txMock.issueConfirmation.upsert).not.toHaveBeenCalled();
  });

  it("structures an incoming human report with duplicate check and inferred metadata", async () => {
    db.bug.findFirst.mockResolvedValue({
      id: "bug-1",
      title: "Login issue",
      description: "When I click login on mobile it crashes",
      projectId: "proj-1",
      tenantId: "tenant-1",
      categoryId: null,
      typeId: null,
      duplicateOfId: null,
      status: "open",
    });

    const result = await structureIssue(mockAgent, "proj-1", "bug-1", {
      title: "Login crashes on mobile",
      stepsToReproduce: "1. Tap login",
      expectedBehavior: "Sign in completes",
      actualBehavior: "Immediate crash",
      environment: "iPhone 15",
      checkDuplicates: true,
    });

    expect(result.ok).toBe(true);
    expect(result.structured).toBe(true);
    expect(result.potentialDuplicates.length).toBe(1);
    expect(result.inferred.categoryId).toBe("cat-mobile");
    expect(result.inferred.typeId).toBe("type-bug");

    expect(txMock.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "bug-1" },
        data: expect.objectContaining({
          title: "Login crashes on mobile",
          description: expect.stringContaining("### Steps to Reproduce"),
          categoryId: "cat-mobile",
          typeId: "type-bug",
        }),
      }),
    );
    // Structuring is not a confirmation: format validations were retired (#issue-confirmations).
    expect(txMock.issueConfirmation.upsert).not.toHaveBeenCalled();
    expect(txMock.bugActivity.create).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      txMock,
      expect.objectContaining({
        type: "issue.structured",
        bugId: "bug-1",
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      mockAgent,
      "issue.structured",
      "bug-1",
      expect.anything(),
      expect.objectContaining({ db: txMock, bugId: "bug-1" }),
    );
  });
});
