import { beforeEach, describe, expect, it, vi } from "vitest";
import { IssueApiError } from "@/lib/agent-api/errors";

const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
  bug: { findFirst: vi.fn() },
  issueClaim: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
}));
const isConfirmed = vi.hoisted(() => vi.fn());
const notifyClaimOffered = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/confirmations", () => ({ isConfirmed }));
vi.mock("@/lib/agent-notifications", () => ({ notifyClaimOffered }));
vi.mock("@/lib/redesigns", () => ({ assertRedesignOpen: vi.fn() }));

import { offerIssue } from "./offer";

const agent = {
  agentId: "agent-ada",
  name: "Ada's Claude",
  ownerId: "ada",
  tenantId: "tenant",
  level: "working" as const,
  burst: false,
  keyId: "key-ada",
};

const pendingOffer = {
  id: "claim-existing",
  bugId: "bug-1",
  agentId: "agent-bob",
  beneficiaryUserId: "bob",
  status: "offered",
  offeredAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  db.$queryRaw.mockResolvedValue([{ id: "bug-1" }]);
  db.$transaction.mockImplementation((run: (tx: unknown) => unknown) => run(db));
  db.bug.findFirst.mockResolvedValue({
    id: "bug-1",
    title: "Example",
    projectId: "project-1",
    status: "open",
    assigneeId: null,
    voteCount: 3,
    convertedToIssueAt: new Date("2026-10-01T00:00:00Z"),
  });
  db.issueClaim.findFirst.mockResolvedValue(pendingOffer);
  isConfirmed.mockResolvedValue(true);
});

describe("manual issue offers (#590)", () => {
  it("returns an existing pending offer instead of creating another one", async () => {
    const result = await offerIssue(agent, "project-1", "bug-1");

    expect(result).toBe(pendingOffer);
    expect(db.issueClaim.create).not.toHaveBeenCalled();
    expect(db.issueClaim.update).not.toHaveBeenCalled();
    expect(notifyClaimOffered).not.toHaveBeenCalled();
  });
  it("blocks with 409 waiting_for_human when human approval is required before offer (#598)", async () => {
    (db as Record<string, unknown>).approvalRule = {
      findMany: vi.fn(async () => [
        { id: "rule-1", stage: "before_offer", issueTypeId: null, severity: null, fileGlob: null },
      ]),
    };
    (db as Record<string, unknown>).issueApproval = {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "appr-wait", status: "pending" })),
    };
    (db as Record<string, unknown>).membership = {
      findMany: vi.fn(async () => []),
    };
    (db as Record<string, unknown>).agentEvent = {
      create: vi.fn(async () => ({ id: "event-1" })),
    };
    (db as Record<string, unknown>).webhookSubscription = {
      findMany: vi.fn(async () => []),
    };

    let error: IssueApiError | null = null;
    try {
      await offerIssue(agent, "project-1", "bug-1");
    } catch (e) {
      error = e as IssueApiError;
    }

    expect(error).toBeInstanceOf(IssueApiError);
    expect(error?.status).toBe(409);
    expect(error?.message).toBe("waiting_for_human");
    expect(error?.body).toEqual({ approvalId: "appr-wait" });
  });
});