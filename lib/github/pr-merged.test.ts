import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const publish = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent-api/events", () => ({ publish }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { resolveIssuesForMergedPullRequest, verifyGithubSignature } from "./pr-merged";

const sign = (body: string, secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("verifyGithubSignature (#474)", () => {
  it("accepts the right signature and rejects a wrong, missing or malformed one", () => {
    expect(verifyGithubSignature("{}", sign("{}", "s"), "s")).toBe(true);
    expect(verifyGithubSignature("{}", sign("{}", "other"), "s")).toBe(false);
    expect(verifyGithubSignature("{ }", sign("{}", "s"), "s")).toBe(false);
    expect(verifyGithubSignature("{}", null, "s")).toBe(false);
    expect(verifyGithubSignature("{}", "sha256=short", "s")).toBe(false);
  });
});

describe("resolveIssuesForMergedPullRequest (#474)", () => {
  it("resolves the linked issue, records the activity and releases the claim", async () => {
    publish.mockClear();
    const tx = { bug: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) }, bugActivity: { create: vi.fn() }, issueClaim: { updateMany: vi.fn() } };
    const db = {
      bug: { findMany: vi.fn().mockResolvedValue([{
        id: "bug-1", tenantId: "t", projectId: "p", status: "in_progress", assigneeId: "person", reporterId: "rep",
        claims: [{ id: "claim-1", agentId: "agent-1", beneficiaryUserId: "person" }],
      }]) },
      $transaction: vi.fn((fn: (t: typeof tx) => Promise<boolean>) => fn(tx)),
    };
    const ids = await resolveIssuesForMergedPullRequest("https://github.com/o/r/pull/1", db as never);
    expect(ids).toEqual(["bug-1"]);
    expect(db.bug.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { pullRequestUrl: "https://github.com/o/r/pull/1", isDeleted: false, status: { in: ["requires_confirmation", "open", "in_progress"] } },
    }));
    expect(tx.bug.updateMany).toHaveBeenCalledWith({ where: { id: "bug-1", status: { in: ["requires_confirmation", "open", "in_progress"] } }, data: { status: "resolved" } });
    expect(tx.bugActivity.create).toHaveBeenCalledWith({ data: expect.objectContaining({ bugId: "bug-1", actorId: "person", type: "status_changed" }) });
    expect(tx.issueClaim.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ releaseReason: "resolved" }) }));
    expect(publish.mock.calls.map((c) => c[1].type)).toEqual(["claim.released", "issue.updated"]);
  });

  it("records and publishes nothing when the issue was resolved first (redelivery or a person)", async () => {
    publish.mockClear();
    const tx = { bug: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) }, bugActivity: { create: vi.fn() }, issueClaim: { updateMany: vi.fn() } };
    const db = {
      bug: { findMany: vi.fn().mockResolvedValue([{
        id: "bug-1", tenantId: "t", projectId: "p", status: "in_progress", assigneeId: "person", reporterId: "rep",
        claims: [{ id: "claim-1", agentId: "agent-1", beneficiaryUserId: "person" }],
      }]) },
      $transaction: vi.fn((fn: (t: typeof tx) => Promise<boolean>) => fn(tx)),
    };
    expect(await resolveIssuesForMergedPullRequest("https://github.com/o/r/pull/1", db as never)).toEqual([]);
    expect(tx.bugActivity.create).not.toHaveBeenCalled();
    expect(tx.issueClaim.updateMany).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("never selects or updates a closed issue (#624)", async () => {
    const db = { bug: { findMany: vi.fn().mockResolvedValue([]) }, $transaction: vi.fn() };
    await resolveIssuesForMergedPullRequest("https://github.com/o/r/pull/3", db as never);
    const status = db.bug.findMany.mock.calls[0][0].where.status as { in: string[] };
    expect(status.in).not.toContain("closed");
    expect(status.in).not.toContain("resolved");
  });

  it("leaves an issue closed between the read and the transaction closed (#624)", async () => {
    publish.mockClear();
    // The conditional update matches nothing once someone has closed the issue.
    const tx = { bug: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) }, bugActivity: { create: vi.fn() }, issueClaim: { updateMany: vi.fn() } };
    const db = {
      bug: { findMany: vi.fn().mockResolvedValue([{
        id: "bug-2", tenantId: "t", projectId: "p", status: "open", assigneeId: null, reporterId: "rep", claims: [],
      }]) },
      $transaction: vi.fn((fn: (t: typeof tx) => Promise<boolean>) => fn(tx)),
    };
    expect(await resolveIssuesForMergedPullRequest("https://github.com/o/r/pull/4", db as never)).toEqual([]);
    expect(tx.bug.updateMany).toHaveBeenCalledWith({ where: { id: "bug-2", status: { in: ["requires_confirmation", "open", "in_progress"] } }, data: { status: "resolved" } });
    expect(tx.bugActivity.create).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("does nothing when no open issue links that pull request", async () => {
    const db = { bug: { findMany: vi.fn().mockResolvedValue([]) }, $transaction: vi.fn() };
    expect(await resolveIssuesForMergedPullRequest("https://github.com/o/r/pull/2", db as never)).toEqual([]);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
