import { describe, expect, it, vi } from "vitest";
import {
  ALREADY_CORRECTED,
  ALREADY_RESOLVED,
  DISPUTE_ALREADY_OPEN,
  NO_ENTRY_ON_THIS_DISPUTE,
  NOBODY_TO_AWARD,
  NOT_IN_WORKSPACE,
  NOT_YOUR_ENTRY,
  correctionSourceKey,
  correctEntry,
  creditMissingAwards,
  disputeInputSchema,
  disputesForMember,
  grantMissingAward,
  missingAwardEntry,
  openDispute,
  openDisputes,
  parseIssueNumbers,
  rejectDispute,
  type DisputeInput,
  type DisputeRow,
} from "./disputes";

/** The fake `award()` ledger: same unique-by-sourceKey rule as Postgres. */
function fakeLedger() {
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    pointEntry: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        let count = 0;
        for (const row of data) {
          if (rows.some((existing) => existing.sourceKey === row.sourceKey)) continue;
          rows.push(row);
          count += 1;
        }
        return { count };
      }),
      update: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
      findFirst: vi.fn(
        async (
          args: { where: Record<string, unknown> },
        ): Promise<{ id: string; correctedAt?: Date | null } | null> => {
          void args;
          return null;
        },
      ),
      findUnique: vi.fn(async (): Promise<{ id: string; correctedAt?: Date | null } | null> => null),
      findMany: vi.fn(async (): Promise<unknown[]> => []),
    },
    pointDispute: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "dispute-new",
        ...data,
      })),
      update: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
      findMany: vi.fn(async (): Promise<unknown[]> => []),
    },
    bug: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
      findMany: vi.fn(async (): Promise<unknown[]> => []),
    },
  };
  return { rows, db: db as never, raw: db };
}

const TENANT = "tenant-a";
const OTHER_TENANT = "tenant-b";
const ME = "user-me";
const ADMIN = "user-admin";

const bugOn = {
  id: "bug-1",
  number: 42,
  tenantId: TENANT,
  reporterId: ME,
  assigneeId: "user-solver",
};

function openDisputeRow(overrides: Partial<DisputeRow> = {}): DisputeRow {
  return {
    id: "dispute-1",
    tenantId: TENANT,
    userId: ME,
    bugId: bugOn.id,
    pointEntryId: null,
    status: "open",
    ...overrides,
  };
}

describe("disputeInputSchema", () => {
  it("accepts a missing-award dispute with a role", () => {
    const parsed = disputeInputSchema.safeParse({
      bugNumber: "42",
      kind: "missing",
      role: "solver",
      reason: "I resolved it but got nothing.",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a missing-award dispute with no role", () => {
    const parsed = disputeInputSchema.safeParse({
      bugNumber: "42",
      kind: "missing",
      reason: "Something is missing.",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a wrong-award dispute with no entry id", () => {
    const parsed = disputeInputSchema.safeParse({
      bugNumber: "42",
      kind: "wrong",
      reason: "The points look wrong.",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("missingAwardEntry", () => {
  it("builds the canonical solver award worth the flat 750 points", () => {
    expect(missingAwardEntry(bugOn, "solver")).toEqual({
      tenantId: TENANT,
      userId: "user-solver",
      bugId: "bug-1",
      role: "solver",
      points: 750,
      sourceKey: "solver:bug-1:user-solver",
    });
  });

  it("builds the canonical reporter award worth 150 points", () => {
    const entry = missingAwardEntry(bugOn, "reporter");
    expect(entry?.points).toBe(150);
    expect(entry?.sourceKey).toBe("reporter:bug-1:user-me");
  });

  it("pays the beneficiary and keys idempotency on them like the canonical award (#599)", () => {
    // Canonical rule (lib/agent-api/validation.ts): userId = beneficiary ?? reporter.
    // The grant must land on the exact same sourceKey so award() dedupes.
    const entry = missingAwardEntry({ ...bugOn, reporterId: "other-user", beneficiaryUserId: ME }, "reporter");
    expect(entry).toMatchObject({
      userId: ME,
      sourceKey: "reporter:bug-1:user-me",
    });
  });

  it("falls back to the reporter when no beneficiary is set (#599)", () => {
    const entry = missingAwardEntry({ ...bugOn, beneficiaryUserId: null }, "reporter");
    expect(entry).toMatchObject({
      userId: ME,
      sourceKey: "reporter:bug-1:user-me",
    });
  });

  it("uses platform/project reward amounts when provided", () => {
    const config = {
      solver: 20,
      reporter: 7,
      reviewer: 12,
      guidelines: null,
    };
    expect(missingAwardEntry(bugOn, "reporter", config)?.points).toBe(7);
    expect(missingAwardEntry(bugOn, "solver", config)?.points).toBe(20);
  });

  it("returns null for a solver award when nobody is assigned", () => {
    expect(missingAwardEntry({ ...bugOn, assigneeId: null }, "solver")).toBeNull();
  });
});

describe("openDispute", () => {
  const input: DisputeInput = {
    bugNumber: 42,
    kind: "missing",
    role: "solver",
    reason: "I resolved it but got nothing.",
  };

  it("rejects a bug from another tenant", async () => {
    const { db } = fakeLedger();
    const result = await openDispute(db, { tenantId: OTHER_TENANT, userId: ME, input });
    expect(result).toEqual({ ok: false, error: NOT_IN_WORKSPACE });
  });

  it("opens a dispute on an issue in the member's own workspace", async () => {
    const { db, raw } = fakeLedger();
    raw.bug.findFirst.mockResolvedValue({ id: "bug-1" });
    const result = await openDispute(db, { tenantId: TENANT, userId: ME, input });
    expect(result).toEqual({ ok: true, disputeId: "dispute-new" });
    expect(raw.pointDispute.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: TENANT,
          userId: ME,
          bugId: "bug-1",
          pointEntryId: null,
          requestedRole: "solver",
        }),
      }),
    );
  });

  it("rejects disputing a points entry that isn't yours", async () => {
    const { db, raw } = fakeLedger();
    raw.bug.findFirst.mockResolvedValue({ id: "bug-1" });
    raw.pointEntry.findFirst.mockResolvedValue(null);
    const result = await openDispute(db, {
      tenantId: TENANT,
      userId: ME,
      input: { bugNumber: 42, kind: "wrong", pointEntryId: "entry-x", reason: "Wrong amount." },
    });
    expect(result).toEqual({ ok: false, error: NOT_YOUR_ENTRY });
  });

  it("rejects disputing an already corrected points entry (#622)", async () => {
    const { db, raw } = fakeLedger();
    raw.bug.findFirst.mockResolvedValue({ id: "bug-1" });
    raw.pointEntry.findFirst.mockResolvedValue({ id: "entry-1", correctedAt: new Date() });
    const result = await openDispute(db, {
      tenantId: TENANT,
      userId: ME,
      input: { bugNumber: 42, kind: "wrong", pointEntryId: "entry-1", reason: "Wrong amount." },
    });
    expect(result).toEqual({ ok: false, error: ALREADY_CORRECTED });
  });

  it("rejects disputing an entry when an open dispute is already pending (#622)", async () => {
    const { db, raw } = fakeLedger();
    raw.bug.findFirst.mockResolvedValue({ id: "bug-1" });
    raw.pointEntry.findFirst.mockResolvedValue({ id: "entry-1", correctedAt: null });
    raw.pointDispute.findFirst.mockResolvedValue({ id: "dispute-existing" });
    const result = await openDispute(db, {
      tenantId: TENANT,
      userId: ME,
      input: { bugNumber: 42, kind: "wrong", pointEntryId: "entry-1", reason: "Wrong amount." },
    });
    expect(result).toEqual({ ok: false, error: DISPUTE_ALREADY_OPEN });
  });

  it("rejects disputing an entry from a different issue", async () => {
    const { db, raw } = fakeLedger();
    raw.bug.findFirst.mockResolvedValue({ id: "bug-1" });
    const otherIssueEntry = {
      id: "entry-x",
      userId: ME,
      tenantId: TENANT,
      bugId: "bug-2",
    };
    raw.pointEntry.findFirst.mockImplementation(async ({ where }) => {
      const matchesEntry =
        where.id === otherIssueEntry.id &&
        where.userId === otherIssueEntry.userId &&
        where.tenantId === otherIssueEntry.tenantId &&
        (where.bugId === undefined || where.bugId === otherIssueEntry.bugId);
      return matchesEntry ? { id: otherIssueEntry.id, correctedAt: null } : null;
    });

    const result = await openDispute(db, {
      tenantId: TENANT,
      userId: ME,
      input: { bugNumber: 42, kind: "wrong", pointEntryId: "entry-x", reason: "Wrong issue." },
    });

    expect(result).toEqual({ ok: false, error: NOT_YOUR_ENTRY });
    expect(raw.pointDispute.create).not.toHaveBeenCalled();
  });
});

describe("grantMissingAward", () => {
  it("grants the missing solver award once", async () => {
    const { db, raw } = fakeLedger();
    const result = await grantMissingAward(db, {
      dispute: openDisputeRow(),
      bug: bugOn,
      role: "solver",
      resolvedById: ADMIN,
    });
    expect(result).toEqual({ ok: true, awarded: true });
    expect(raw.pointEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            role: "solver",
            points: 750,
            sourceKey: "solver:bug-1:user-solver",
          }),
        ],
      }),
    );
    expect(raw.pointDispute.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "dispute-1" },
        data: expect.objectContaining({ status: "granted", resolvedById: ADMIN }),
      }),
    );
  });

  it("granting twice does not add points twice", async () => {
    // A race: both grants see the dispute still open, but the ledger's unique
    // sourceKey keeps the points honest.
    const { db, rows } = fakeLedger();
    const first = await grantMissingAward(db, {
      dispute: openDisputeRow(),
      bug: bugOn,
      role: "solver",
      resolvedById: ADMIN,
    });
    const second = await grantMissingAward(db, {
      dispute: openDisputeRow(),
      bug: bugOn,
      role: "solver",
      resolvedById: ADMIN,
    });
    expect(first).toEqual({ ok: true, awarded: true });
    expect(second).toEqual({ ok: true, awarded: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ points: 750 });
  });

  it("refuses to resolve a dispute that is already resolved", async () => {
    const { db, rows } = fakeLedger();
    const result = await grantMissingAward(db, {
      dispute: openDisputeRow({ status: "granted" }),
      bug: bugOn,
      role: "solver",
      resolvedById: ADMIN,
    });
    expect(result).toEqual({ ok: false, error: ALREADY_RESOLVED });
    expect(rows).toHaveLength(0);
  });

  it("refuses a bug from a different tenant than the dispute", async () => {
    const { db } = fakeLedger();
    const result = await grantMissingAward(db, {
      dispute: openDisputeRow(),
      bug: { ...bugOn, tenantId: OTHER_TENANT },
      role: "solver",
      resolvedById: ADMIN,
    });
    expect(result).toEqual({ ok: false, error: NOT_IN_WORKSPACE });
  });

  it("refuses a solver award when nobody is assigned", async () => {
    const { db } = fakeLedger();
    const result = await grantMissingAward(db, {
      dispute: openDisputeRow(),
      bug: { ...bugOn, assigneeId: null },
      role: "solver",
      resolvedById: ADMIN,
    });
    expect(result).toEqual({ ok: false, error: NOBODY_TO_AWARD });
  });
});

describe("correctEntry", () => {
  const entry = {
    id: "entry-1",
    tenantId: TENANT,
    userId: ME,
    bugId: "bug-1" as string | null,
    role: "solver" as const,
    points: 25,
  };

  it("marks the entry corrected and writes the reversing row", async () => {
    const { db, raw, rows } = fakeLedger();
    const result = await correctEntry(db, {
      dispute: openDisputeRow({ pointEntryId: "entry-1" }),
      entry,
      resolvedById: ADMIN,
      note: "It was a low, not a medium.",
    });
    expect(result).toEqual({ ok: true, awarded: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      points: -25,
      sourceKey: correctionSourceKey("entry-1"),
    });
    expect(raw.pointEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "entry-1" },
        data: { correctedAt: expect.any(Date) },
      }),
    );
    expect(raw.pointDispute.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "granted",
          resolution: "It was a low, not a medium.",
        }),
      }),
    );
  });

  it("refuses an entry the dispute doesn't point at", async () => {
    const { db, rows } = fakeLedger();
    const result = await correctEntry(db, {
      dispute: openDisputeRow({ pointEntryId: "entry-other" }),
      entry,
      resolvedById: ADMIN,
    });
    expect(result).toEqual({ ok: false, error: NO_ENTRY_ON_THIS_DISPUTE });
    expect(rows).toHaveLength(0);
  });

  it("refuses a dispute that is already resolved", async () => {
    const { db } = fakeLedger();
    const result = await correctEntry(db, {
      dispute: openDisputeRow({ pointEntryId: "entry-1", status: "rejected" }),
      entry,
      resolvedById: ADMIN,
    });
    expect(result).toEqual({ ok: false, error: ALREADY_RESOLVED });
  });

  it("refuses to correct an entry that is already marked corrected (#622)", async () => {
    const { db, rows } = fakeLedger();
    const result = await correctEntry(db, {
      dispute: openDisputeRow({ pointEntryId: "entry-1" }),
      entry: { ...entry, correctedAt: new Date() },
      resolvedById: ADMIN,
    });
    expect(result).toEqual({ ok: false, error: ALREADY_CORRECTED });
    expect(rows).toHaveLength(0);
  });

  it("refuses to correct an entry when db record is already corrected (#622)", async () => {
    const { db, raw, rows } = fakeLedger();
    raw.pointEntry.findUnique.mockResolvedValue({ id: "entry-1", correctedAt: new Date() });
    const result = await correctEntry(db, {
      dispute: openDisputeRow({ pointEntryId: "entry-1" }),
      entry,
      resolvedById: ADMIN,
    });
    expect(result).toEqual({ ok: false, error: ALREADY_CORRECTED });
    expect(rows).toHaveLength(0);
  });

  it("multiple calls to correct the same entry are idempotent and never double-deduct (#622)", async () => {
    const { db, rows } = fakeLedger();
    const first = await correctEntry(db, {
      dispute: openDisputeRow({ id: "dispute-1", pointEntryId: "entry-1" }),
      entry,
      resolvedById: ADMIN,
    });
    expect(first).toEqual({ ok: true, awarded: true });

    // A concurrent second dispute resolution on the same entry:
    const second = await correctEntry(db, {
      dispute: openDisputeRow({ id: "dispute-2", pointEntryId: "entry-1" }),
      entry,
      resolvedById: ADMIN,
    });
    expect(second).toEqual({ ok: true, awarded: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ points: -25, sourceKey: "undo:entry-1" });
  });
});

describe("rejectDispute", () => {
  it("rejects an open dispute without touching the ledger", async () => {
    const { db, raw, rows } = fakeLedger();
    const result = await rejectDispute(db, {
      dispute: openDisputeRow(),
      resolvedById: ADMIN,
      note: "The award is already there.",
    });
    expect(result).toEqual({ ok: true, disputeId: "dispute-1" });
    expect(rows).toHaveLength(0);
    expect(raw.pointDispute.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "rejected", resolution: "The award is already there." }),
      }),
    );
  });

  it("refuses to reject a dispute that is already resolved", async () => {
    const { db } = fakeLedger();
    const result = await rejectDispute(db, {
      dispute: openDisputeRow({ status: "granted" }),
      resolvedById: ADMIN,
    });
    expect(result).toEqual({ ok: false, error: ALREADY_RESOLVED });
  });
});

describe("dispute list queries", () => {
  it("maps a dispute row to the view shape", async () => {
    const { db, raw } = fakeLedger();
    raw.pointDispute.findMany.mockResolvedValue([
      {
        id: "dispute-1",
        status: "open",
        reason: "Missing solver award.",
        resolution: null,
        resolvedAt: null,
        createdAt: new Date("2026-10-19"),
        pointEntryId: null,
        requestedRole: "solver",
        bug: { id: "bug-1", number: 42, title: "Login is broken", project: { slug: "ziki" } },
        user: { id: ME, name: "Ada" },
        pointEntry: null,
      },
    ]);
    const views = await openDisputes(db, TENANT);
    expect(views).toEqual([
      expect.objectContaining({
        id: "dispute-1",
        kind: "missing",
        requestedRole: "solver",
        bugNumber: 42,
        bugPath: "/ziki/42",
        openerName: "Ada",
        entry: null,
      }),
    ]);
  });

  it("scopes a member's disputes to their tenant and user", async () => {
    const { db, raw } = fakeLedger();
    await disputesForMember(db, { tenantId: TENANT, userId: ME });
    expect(raw.pointDispute.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT, userId: ME } }),
    );
  });
});

describe("creditMissingAwards", () => {
  const solved = {
    id: "bug-269",
    number: 269,
    tenantId: TENANT,
    reporterId: ME,
    assigneeId: "user-solver",
    status: "resolved",
    isDeleted: false,
    duplicateOfId: null,
  };

  it("parses a loose list of issue numbers", () => {
    expect(parseIssueNumbers("#269, #270 #10 and 271")).toEqual([269, 270, 10, 271]);
  });

  it("credits a resolved assigned issue once, and skips the rest", async () => {
    const { db, raw } = fakeLedger();
    raw.bug.findMany.mockResolvedValue([
      solved,
      { ...solved, id: "bug-10", number: 10, assigneeId: null },
      { ...solved, id: "bug-11", number: 11, status: "open", assigneeId: "user-solver" },
      { ...solved, id: "bug-12", number: 12, duplicateOfId: "bug-1" },
    ]);

    const first = await creditMissingAwards(db, {
      tenantId: TENANT,
      numbers: [269, 10, 11, 999],
      role: "solver",
    });
    expect(first).toEqual({
      credited: [269],
      already: [],
      skipped: [
        { number: 10, reason: "no assignee" },
        { number: 11, reason: "not resolved" },
        { number: 999, reason: "not in this workspace" },
      ],
    });

    const again = await creditMissingAwards(db, {
      tenantId: TENANT,
      numbers: [269],
      role: "solver",
    });
    expect(again.credited).toEqual([]);
    expect(again.already).toEqual([269]);
  });

  it("withholds the reporter award on a duplicate and pays it otherwise", async () => {
    const { db, raw } = fakeLedger();
    raw.bug.findMany.mockResolvedValue([
      { ...solved, status: "open" },
      { ...solved, id: "bug-12", number: 12, duplicateOfId: "bug-1" },
    ]);
    const result = await creditMissingAwards(db, {
      tenantId: TENANT,
      numbers: [269, 12],
      role: "reporter",
    });
    expect(result.credited).toEqual([269]);
    expect(result.skipped).toEqual([{ number: 12, reason: "duplicate" }]);
    expect(raw.pointEntry.createMany.mock.calls[0][0].data[0]).toMatchObject({
      role: "reporter",
      points: 150,
      sourceKey: "reporter:bug-269:user-me",
    });
  });
});
