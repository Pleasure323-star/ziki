import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
  issueClaim: { findFirst: vi.fn(), update: vi.fn() },
  bug: { findFirst: vi.fn() },
  project: { findUnique: vi.fn() },
  projectWorkflow: { findUnique: vi.fn() },
}));
const publish = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/events", () => ({ publish }));

import { extendClaim } from "./deadline";
import { resetWorkflowCache } from "@/lib/workflow";

const now = new Date("2026-10-19T12:00:00.000Z");
const agent = {
  agentId: "agent-ada",
  name: "Ada's Claude",
  ownerId: "ada",
  tenantId: "tenant",
  level: "working" as const,
  burst: false,
  keyId: "key-ada",
};
const claim = {
  id: "claim",
  deliverBy: new Date("2026-10-19T12:15:00.000Z"),
  extendedAt: null,
  bug: { projectId: "project", pullRequestUrl: null },
};

beforeEach(() => {
  vi.resetAllMocks();
  resetWorkflowCache();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  db.$queryRaw.mockResolvedValue([{ id: "issue" }]);
  db.$transaction.mockImplementation((run: (tx: typeof db) => unknown) => run(db));
  db.issueClaim.findFirst.mockResolvedValue(claim);
  db.issueClaim.update.mockResolvedValue({});
  db.project.findUnique.mockResolvedValue({ deliveryWindowMinutes: 15 });
  db.projectWorkflow.findUnique.mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

describe("claim extension (#593)", () => {
  it("moves the deadline by one more window and publishes claim.extended", async () => {
    await expect(extendClaim(agent, "project", "issue", "waiting on review")).resolves.toEqual({
      claimId: "claim",
      issueId: "issue",
      deliverBy: new Date("2026-10-19T16:15:00.000Z"),
      extendedAt: now,
      reason: "waiting on review",
    });
    expect(db.issueClaim.update).toHaveBeenCalledWith({
      where: { id: "claim" },
      data: {
        deliverBy: new Date("2026-10-19T16:15:00.000Z"),
        extendedAt: now,
        extensionReason: "waiting on review",
      },
    });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({
      type: "claim.extended",
      actorAgentId: "agent-ada",
      bugId: "issue",
      payload: expect.objectContaining({
        claimId: "claim",
        issueId: "issue",
        projectId: "project",
        deliverBy: "2026-10-19T16:15:00.000Z",
        reason: "waiting on review",
      }),
    }));
  });

  it("uses the project's configured delivery window (#595)", async () => {
    db.projectWorkflow.findUnique.mockResolvedValue({ deliveryMinutes: 30 });
    const result = await extendClaim(agent, "project", "issue", "still testing");
    expect(result.deliverBy).toEqual(new Date("2026-10-19T12:45:00.000Z"));
  });

  it("takes a short project window as given, with no floor for any issue", async () => {
    db.projectWorkflow.findUnique.mockResolvedValue({ deliveryMinutes: 15 });
    const result = await extendClaim(agent, "project", "issue", "still testing");
    expect(result.deliverBy).toEqual(new Date("2026-10-19T12:30:00.000Z"));
  });

  it("refuses a second extension", async () => {
    db.issueClaim.findFirst.mockResolvedValue({ ...claim, extendedAt: new Date("2026-10-19T12:05:00.000Z") });
    await expect(extendClaim(agent, "project", "issue", "again")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already used"),
    });
    expect(db.issueClaim.update).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses when there is no active claim", async () => {
    db.issueClaim.findFirst.mockResolvedValue(null);
    await expect(extendClaim(agent, "project", "issue", "please")).rejects.toMatchObject({ status: 409 });
    expect(db.issueClaim.update).not.toHaveBeenCalled();
  });

  it("refuses after the deadline has passed", async () => {
    db.issueClaim.findFirst.mockResolvedValue({ ...claim, deliverBy: new Date("2026-10-19T11:59:00.000Z") });
    await expect(extendClaim(agent, "project", "issue", "late")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("deadline has passed"),
    });
  });

  it("refuses when a fix is already linked", async () => {
    db.issueClaim.findFirst.mockResolvedValue({ ...claim, bug: { ...claim.bug, pullRequestUrl: "https://github.com/o/r/pull/1" } });
    await expect(extendClaim(agent, "project", "issue", "already done")).rejects.toMatchObject({ status: 409 });
    expect(db.issueClaim.update).not.toHaveBeenCalled();
  });
});

describe("extension accepts the readable issue number (#604)", () => {
  it.each(["42", "ZE-42"])("resolves %s inside the agent's tenant and extends that claim", async (ref) => {
    db.bug.findFirst.mockResolvedValue({ id: "issue", number: 42 });

    const result = await extendClaim(agent, "project", ref, "waiting on CI");

    expect(db.bug.findFirst.mock.calls[0][0].where).toEqual({ number: 42, tenantId: "tenant" });
    expect(db.issueClaim.findFirst.mock.calls[0][0].where).toMatchObject({ bugId: "issue", agentId: "agent-ada" });
    expect(result).toMatchObject({ claimId: "claim", issueId: "issue" });
    expect(db.issueClaim.update).toHaveBeenCalledTimes(1);
  });

  it("is 404 when no issue in the tenant has that number", async () => {
    db.bug.findFirst.mockResolvedValue(null);
    await expect(extendClaim(agent, "project", "999", "waiting on CI")).rejects.toMatchObject({ status: 404 });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.issueClaim.update).not.toHaveBeenCalled();
  });

  it("still checks the project for a number from another project in the tenant", async () => {
    db.bug.findFirst.mockResolvedValue({ id: "other", number: 7 });
    db.$queryRaw.mockResolvedValue([]);
    await expect(extendClaim(agent, "project", "7", "waiting on CI")).rejects.toMatchObject({ status: 404 });
    expect(db.issueClaim.update).not.toHaveBeenCalled();
  });

  it("keeps the id lookup unchanged for an internal id", async () => {
    await extendClaim(agent, "project", "issue", "waiting on CI");
    expect(db.bug.findFirst).not.toHaveBeenCalled();
  });
});
