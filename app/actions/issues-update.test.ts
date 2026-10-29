import { beforeEach, describe, expect, it, vi } from "vitest";

// #600: these tests are about the actions themselves; the event is checked separately.
const publishWebEvent = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/agent-api/web-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-api/web-events")>()),
  publishWebEvent,
}));
const publish = vi.hoisted(() => vi.fn(async () => ({ id: "evt-1" })));
vi.mock("@/lib/agent-api/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-api/events")>()),
  publish,
}));

// #425: run as a member of the Zedu tenant.
vi.mock("@/lib/tenant-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-context")>()),
  currentTenantIdFor: vi.fn(async () => "tenant-zedu"),
  defaultProjectIdFor: vi.fn(async () => "project-zedu"),
  tenantIdForUser: vi.fn(async () => "tenant-zedu"),
}));

/**
 * Authorization table for updateBugAction (#218): who may change which field
 * of an issue, across role × assignee × self-assigning × field.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/notify", () => ({ notifyLater: vi.fn() }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/tenant-access", () => ({
  currentTenantAccess: vi.fn(async (_id: string, role: string) => ({
    tenantId: "tenant-zedu",
    tenantName: "Zedu",
    tenantSlug: "zedu",
    membershipRole: role === "admin" || role === "super_admin" ? "admin" : "member",
    admin: role === "admin" || role === "super_admin",
  })),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    bug: { findUnique: vi.fn() },
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    issueType: { findUnique: vi.fn() },
    category: { findUnique: vi.fn(), findFirst: vi.fn() },
    projectArea: { findFirst: vi.fn() },
    milestone: { findUnique: vi.fn() },
    issueClaim: { findFirst: vi.fn() },
    bugActivity: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth-helpers";
import { currentTenantAccess } from "@/lib/tenant-access";
import { notifyLater } from "@/lib/notify";
import { TICKET_ASSIGN_ERRORS } from "@/lib/ticket-assignment";
import { TICKET_TRIAGE_ERRORS } from "@/lib/ticket-triage";
import { assignBugAction, closeBugAction, reopenAgentResolvedAction, reopenBugAction, updateBugAction } from "./issues";

const db = prisma as unknown as {
  bug: { findUnique: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  issueType: { findUnique: ReturnType<typeof vi.fn> };
  category: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  projectArea: { findFirst: ReturnType<typeof vi.fn> };
  milestone: { findUnique: ReturnType<typeof vi.fn> };
  issueClaim: { findFirst: ReturnType<typeof vi.fn> };
  bugActivity: { findFirst: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};
const mockUser = requireUser as unknown as ReturnType<typeof vi.fn>;

type Who = "user" | "admin";
const ME = "cmeuser00000001";
const OTHER = "cotheruser00001";
const SOMEONE = "csomeone0000001";

let written: Record<string, unknown> | null;
let activities: string[] = [];
let awarded: Array<Record<string, unknown>> = [];
let claimReleases: Array<Record<string, unknown>> = [];
let activeClaimsMock: Array<{ id: string; agentId: string; beneficiaryUserId: string }> = [];

function issue(assigneeId: string | null, extra: Record<string, unknown> = {}) {
  return {
    id: "bug1",
    tenantId: "tenant-zedu",
    projectId: "project-zedu",
    areaId: null,
    title: "A bug",
    status: "open",
    severity: "medium",
    typeId: null,
    categoryId: null,
    assigneeId,
    reporterId: "reporter",
    isDeleted: false,
    assignee: assigneeId ? { id: assigneeId, name: assigneeId } : null,
    category: null,
    area: null,
    type: null,
    ...extra,
  };
}

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}

async function run(who: Who, assigneeId: string | null, values: Record<string, string>) {
  mockUser.mockResolvedValue({ id: ME, name: "Me", role: who });
  db.bug.findUnique.mockResolvedValue(issue(assigneeId));
  return updateBugAction("bug1", form(values));
}

beforeEach(() => {
  vi.clearAllMocks();
  written = null;
  activities = [];
  awarded = [];
  claimReleases = [];
  activeClaimsMock = [];
  db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ name: where.id }));
  db.user.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({ name: where.id }));
  db.issueType.findUnique.mockResolvedValue({ id: "t1", name: "Fix", isActive: true });
  db.category.findFirst.mockResolvedValue({ id: "c1", name: "Web", tenantId: "tenant-zedu" });
  db.projectArea.findFirst.mockResolvedValue({ id: "area-web", name: "Frontend" });
  db.issueClaim.findFirst.mockResolvedValue({ id: "claim-1" });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      bug: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (written = data)),
        findUnique: vi.fn(async () => ({ projectId: null })),
      },
      bugActivity: {
        createMany: vi.fn(async ({ data }: { data: Array<{ type: string }> }) => {
          activities = data.map((entry) => entry.type);
        }),
      },
      // Used once assignees auto-watch issues (#216).
      issueWatch: { createMany: vi.fn() },
      issueClaim: {
        findMany: vi.fn(async () => activeClaimsMock),
        updateMany: vi.fn(async (input: Record<string, unknown>) => { claimReleases.push(input); return { count: 1 }; }),
      },
      projectArea: { findFirst: db.projectArea.findFirst },
      // #428: the points ledger.
      pointEntry: {
        createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
          awarded.push(...data);
          return { count: data.length };
        }),
      },
    }),
  );
});

describe("updateBugAction authorization (#218)", () => {
  it.each([
    // [who, current assignee, form, expected error or null, expected written data]
    ["user", null, { status: "resolved" }, TICKET_TRIAGE_ERRORS.statusUnauthorized, null],
    ["user", OTHER, { status: "resolved" }, TICKET_TRIAGE_ERRORS.statusUnauthorized, null],
    ["user", null, { assigneeId: ME }, TICKET_ASSIGN_ERRORS.needsAgentClaim, null],
    ["user", null, { assigneeId: ME, status: "resolved" }, TICKET_TRIAGE_ERRORS.statusUnauthorized, null],
    ["user", null, { assigneeId: ME, status: "open" }, TICKET_TRIAGE_ERRORS.statusUnauthorized, null],
    ["user", OTHER, { assigneeId: ME }, TICKET_ASSIGN_ERRORS.needsAgentClaim, null],
    // Ziki #713: nobody sets a status by hand, the assignee and admins included.
    ["user", ME, { status: "resolved" }, TICKET_TRIAGE_ERRORS.statusUnauthorized, null],
    ["user", ME, { status: "in_progress", severity: "critical", typeId: "t1", categoryId: "c1" }, TICKET_TRIAGE_ERRORS.statusUnauthorized, null],
    ["user", ME, { assigneeId: OTHER }, TICKET_ASSIGN_ERRORS.unauthorized, null],
    ["user", ME, { assigneeId: "" }, null, { assigneeId: null }],
    ["admin", OTHER, { assigneeId: SOMEONE, severity: "critical", status: "closed" }, TICKET_TRIAGE_ERRORS.statusUnauthorized, null],
    ["admin", OTHER, { assigneeId: SOMEONE, severity: "critical" }, null, { severity: "critical", assigneeId: SOMEONE }],
    ["admin", null, { typeId: "t1", categoryId: "c1" }, null, { typeId: "t1", categoryId: "c1" }],
  ] as const)(
    "%s on an issue assigned to %s, sending %j → %s",
    async (who, assignee, values, error, data) => {
      const result = await run(who, assignee, { ...values });
      if (error) {
        expect(result).toEqual({ error });
        expect(written).toBeNull();
      } else {
        expect(result).toEqual({ ok: true });
        expect(written).toEqual(data);
        if (data && "assigneeId" in data && data.assigneeId) {
          expect(db.user.findFirst).toHaveBeenCalledWith({
            where: { id: data.assigneeId, memberships: { some: { tenantId: "tenant-zedu" } } },
            select: { name: true },
          });
        }
      }
    },
  );

  it("refuses an assignee changing the status, with or without an active claim (Ziki #713)", async () => {
    db.issueClaim.findFirst.mockResolvedValue(null);
    expect(await run("user", ME, { status: "resolved" })).toEqual({ error: TICKET_TRIAGE_ERRORS.statusUnauthorized });
    expect(written).toBeNull();
  });

  it("rejects an assignee who is not a member of the issue tenant", async () => {
    mockUser.mockResolvedValue({ id: ME, name: "Me", role: "admin" });
    db.bug.findUnique.mockResolvedValue(issue(null));
    db.user.findFirst.mockResolvedValue(null);

    await expect(updateBugAction("bug1", form({ assigneeId: SOMEONE }))).resolves.toEqual({
      error: "Assignee not found in this workspace",
    });
    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: { id: SOMEONE, memberships: { some: { tenantId: "tenant-zedu" } } },
      select: { name: true },
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses to update a deleted issue", async () => {
    mockUser.mockResolvedValue({ id: ME, name: "Me", role: "admin" });
    db.bug.findUnique.mockResolvedValue(issue(null, { isDeleted: true }));
    await expect(updateBugAction("bug1", form({ status: "closed" }))).resolves.toEqual({
      error: "Issue not found",
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("notifies on an assignment only when something changed", async () => {
    await run("admin", null, { assigneeId: SOMEONE });
    const events = (notifyLater as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(events.map((e: { kind: string }) => e.kind)).toEqual(["assignee_changed"]);

    vi.clearAllMocks();
    await run("admin", SOMEONE, { assigneeId: SOMEONE });
    expect(notifyLater).not.toHaveBeenCalled();
  });

  it("lets admins assign an area from the issue's project and logs it", async () => {
    await expect(run("admin", null, { areaId: "area-web" })).resolves.toEqual({ ok: true });
    expect(db.projectArea.findFirst).toHaveBeenCalledWith({
      where: { id: "area-web", projectId: "project-zedu" },
      select: { id: true, name: true },
    });
    expect(written).toEqual({ areaId: "area-web" });
    expect(activities).toContain("area_changed");
  });
});

describe("a person can't finish an issue by hand (Ziki #713)", () => {
  it.each(["resolved", "closed", "in_progress", "open"])("refuses an admin setting it to %s, and writes nothing", async (status) => {
    mockUser.mockResolvedValue({ id: ME, name: "Me", role: "admin" });
    db.bug.findUnique.mockResolvedValue(issue(null, { isBoosted: true, boostedAt: new Date("2026-10-01T00:00:00Z") }));
    expect(await updateBugAction("bug1", form({ status }))).toEqual({ error: TICKET_TRIAGE_ERRORS.statusUnauthorized });
    expect(written).toBeNull();
    expect(activities).toEqual([]);
    expect(claimReleases).toEqual([]);
  });
});

describe("milestones in triage (#289)", () => {
  const withMilestone = (milestoneId: string | null, title: string | null = null) =>
    issue(null, { milestoneId, milestone: milestoneId ? { id: milestoneId, title } : null });

  it("lets an admin put an issue in a milestone, with an activity entry", async () => {
    mockUser.mockResolvedValue({ id: ME, name: "Me", role: "admin" });
    db.bug.findUnique.mockResolvedValue(withMilestone(null));
    db.milestone.findUnique.mockResolvedValue({ title: "v2.4", isClosed: false });
    expect(await updateBugAction("bug1", form({ milestoneId: "m1" }))).toEqual({ ok: true });
    expect(written).toEqual({ milestoneId: "m1" });
    expect(activities).toEqual(["milestone_changed"]);
  });

  it("takes it out again with an empty value", async () => {
    mockUser.mockResolvedValue({ id: ME, name: "Me", role: "admin" });
    db.bug.findUnique.mockResolvedValue(withMilestone("m1", "v2.4"));
    expect(await updateBugAction("bug1", form({ milestoneId: "" }))).toEqual({ ok: true });
    expect(written).toEqual({ milestoneId: null });
  });

  it("refuses a closed milestone", async () => {
    mockUser.mockResolvedValue({ id: ME, name: "Me", role: "admin" });
    db.bug.findUnique.mockResolvedValue(withMilestone(null));
    db.milestone.findUnique.mockResolvedValue({ title: "v2.3", isClosed: true });
    const result = await updateBugAction("bug1", form({ milestoneId: "m0" }));
    expect(result.error).toMatch(/closed/);
    expect(written).toBeNull();
  });

  it("refuses a milestone that belongs to another organization", async () => {
    mockUser.mockResolvedValue({ id: ME, name: "Me", role: "admin" });
    db.bug.findUnique.mockResolvedValue(withMilestone(null));
    db.milestone.findUnique.mockResolvedValue(null);
    const result = await updateBugAction("bug1", form({ milestoneId: "other-tenant-milestone" }));
    expect(result.error).toMatch(/no longer exists/);
    expect(db.milestone.findUnique).toHaveBeenCalledWith({
      where: {
        id_tenantId: { id: "other-tenant-milestone", tenantId: "tenant-zedu" },
      },
      select: { title: true, isClosed: true },
    });
    expect(written).toBeNull();
  });

  it("ignores the field from a non-admin", async () => {
    mockUser.mockResolvedValue({ id: ME, name: "Me", role: "user" });
    db.bug.findUnique.mockResolvedValue(issue(ME));
    await updateBugAction("bug1", form({ milestoneId: "m1" }));
    expect((written as Record<string, unknown> | null)?.milestoneId).toBeUndefined();
    expect(db.milestone.findUnique).not.toHaveBeenCalled();
  });

  it("does nothing when the milestone is unchanged", async () => {
    mockUser.mockResolvedValue({ id: ME, name: "Me", role: "admin" });
    db.bug.findUnique.mockResolvedValue(withMilestone("m1", "v2.4"));
    expect(await updateBugAction("bug1", form({ milestoneId: "m1" }))).toEqual({ ok: true });
    expect(written).toBeNull();
  });
});

describe("organization role, not the site-wide admin role (#504)", () => {
  it("denies triage to a site admin who is only a member of this organization", async () => {
    vi.mocked(currentTenantAccess).mockResolvedValueOnce({
      tenantId: "tenant-zedu",
      tenantName: "Zedu",
      tenantSlug: "zedu",
      membershipRole: "member",
      admin: false,
    });
    mockUser.mockResolvedValue({ id: ME, name: "Me", role: "admin" });
    db.bug.findUnique.mockResolvedValue(issue(null));

    const result = await updateBugAction("bug1", form({ status: "resolved" }));

    expect(result).toEqual({ error: TICKET_TRIAGE_ERRORS.statusUnauthorized });
    expect(written).toBeNull();
  });
});

describe("no solver points from a person resolving by hand (Ziki #713)", () => {
  it("refuses the assignee resolving it, so nothing is paid", async () => {
    expect(await run("user", ME, { status: "resolved" })).toEqual({ error: TICKET_TRIAGE_ERRORS.statusUnauthorized });
    expect(awarded).toEqual([]);
  });

  it("refuses an admin resolving it, so nothing is paid", async () => {
    expect(await run("admin", OTHER, { status: "resolved", severity: "critical" })).toEqual({ error: TICKET_TRIAGE_ERRORS.statusUnauthorized });
    expect(awarded).toEqual([]);
  });
});

describe("agents hear about triage in the web app (#600, #656)", () => {
  it("publishes nothing and releases no claim when a person tries to resolve it (Ziki #713)", async () => {
    activeClaimsMock = [{ id: "claim-1", agentId: "agent-alpha", beneficiaryUserId: "user-alpha" }];
    expect(await run("user", ME, { status: "resolved" })).toEqual({ error: TICKET_TRIAGE_ERRORS.statusUnauthorized });
    expect(publishWebEvent).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("closeBugAction refuses: nobody closes an issue by hand (Ziki #713)", async () => {
    mockUser.mockResolvedValue({ id: ME, name: "Me", role: "admin" });
    db.bug.findUnique.mockResolvedValue(issue(ME));
    expect(await closeBugAction("bug1", "Completed in PR")).toEqual({ error: TICKET_TRIAGE_ERRORS.statusUnauthorized });
    expect(written).toBeNull();
    expect(publishWebEvent).not.toHaveBeenCalled();
  });

  it("reopenBugAction refuses: nobody reopens an issue by hand (Ziki #713)", async () => {
    mockUser.mockResolvedValue({ id: ME, name: "Me", role: "admin" });
    db.bug.findUnique.mockResolvedValue(issue(ME, { status: "closed" }));
    expect(await reopenBugAction("bug1")).toEqual({ error: TICKET_TRIAGE_ERRORS.statusUnauthorized });
    expect(written).toBeNull();
    expect(publishWebEvent).not.toHaveBeenCalled();
  });

  it("reopenAgentResolvedAction refuses the assignee and admins alike (Ziki #713)", async () => {
    for (const role of ["user", "admin"] as const) {
      mockUser.mockResolvedValue({ id: ME, name: "Me", role });
      db.bug.findUnique.mockResolvedValue(issue(ME, { status: "resolved" }));
      db.bugActivity.findFirst.mockResolvedValue({
        metadata: { field: "status", from: "in_progress", to: "resolved", via: "agent_resolve" },
      });
      expect(await reopenAgentResolvedAction("bug1")).toEqual({ error: TICKET_TRIAGE_ERRORS.statusUnauthorized });
    }
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(written).toBeNull();
  });

  it("assignBugAction assigns issue and emits issue.updated", async () => {
    mockUser.mockResolvedValue({ id: ME, name: "Me", role: "admin" });
    db.bug.findUnique.mockResolvedValue(issue(null));
    const result = await assignBugAction("bug1", SOMEONE);
    expect(result).toEqual({ ok: true });
    expect(written).toEqual(expect.objectContaining({ assigneeId: SOMEONE }));
    expect(publishWebEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        bugId: "bug1",
        type: "issue.updated",
        payload: expect.objectContaining({ values: expect.objectContaining({ assigneeId: SOMEONE }) }),
      }),
    );
  });
});
