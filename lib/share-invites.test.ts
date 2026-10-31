import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-notifications", () => ({ notifyTenantInvite: vi.fn() }));
vi.mock("@/lib/mail", () => ({ canSendMail: vi.fn(), sendMail: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/site-url", () => ({ absoluteUrl: (path: string) => `https://ziki.dev${path}` }));

import { hashInviteToken } from "./invites";
import { openSecret } from "./secret-box";
import {
  SHARE_LINK_ACTIVE_CAP,
  acceptShareLink,
  createShareLink,
  joinedSummary,
  listShareLinks,
  previewShareLink,
  revokeShareLink,
  shareLinkAudience,
  shareLinkState,
} from "./share-invites";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

type Role = "owner" | "admin" | "member";
type User = { id: string; name: string };
type Tenant = { id: string; slug: string; name: string };
type Membership = { id: string; tenantId: string; userId: string; role: Role; createdAt: Date };
type Link = {
  id: string;
  tenantId: string;
  tokenHash: string;
  tokenEncrypted: string;
  label: string | null;
  expiresAt: Date;
  maxUses: number | null;
  useCount: number;
  revokedAt: Date | null;
  invitedById: string;
  createdAt: Date;
};
type Redemption = { id: string; linkId: string; userId: string; createdAt: Date };

function matches(row: object, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    const value = (row as Record<string, unknown>)[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const cond = condition as { gt?: unknown; lt?: unknown };
      if ("gt" in cond) {
        if (value instanceof Date && cond.gt instanceof Date) {
          if (!(value.getTime() > cond.gt.getTime())) return false;
        } else if (typeof value === "number" && typeof cond.gt === "number") {
          if (!(value > cond.gt)) return false;
        } else return false;
      } else if ("lt" in cond) {
        if (!(typeof value === "number" && typeof cond.lt === "number" && value < cond.lt)) return false;
      } else return false;
    } else if (value !== condition) return false;
  }
  return true;
}

function fakeDb() {
  const users: User[] = [];
  const tenants: Tenant[] = [];
  const memberships: Membership[] = [];
  const links: Link[] = [];
  const redemptions: Redemption[] = [];
  let ids = 0;
  const nextId = (prefix: string) => `${prefix}-${++ids}`;
  const tenantOf = (id: string) => tenants.find((tenant) => tenant.id === id)!;
  const userOf = (id: string) => users.find((user) => user.id === id)!;

  function presentLink(link: Link, select: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(select)) {
      if (key === "tenant") out.tenant = { ...tenantOf(link.tenantId) };
      else if (key === "invitedBy") out.invitedBy = { name: userOf(link.invitedById).name };
      else if (key === "redemptions") {
        const spec = select.redemptions as { take?: number; select?: { userId?: boolean } };
        const rows = redemptions
          .filter((redemption) => redemption.linkId === link.id)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, spec.take ?? 8);
        out.redemptions = rows.map((redemption) =>
          spec.select?.userId ? { userId: redemption.userId } : { user: { name: userOf(redemption.userId).name } },
        );
      } else out[key] = link[key as keyof Link];
    }
    return out;
  }

  function applyUseCount(row: Link, data: { useCount?: { increment?: number; decrement?: number }; revokedAt?: Date }) {
    if (data.revokedAt) row.revokedAt = data.revokedAt;
    if (data.useCount?.increment) row.useCount += data.useCount.increment;
    if (data.useCount?.decrement) row.useCount -= data.useCount.decrement;
  }

  const db = {
    users,
    tenants,
    memberships,
    links,
    redemptions,
    user: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        users
          .filter((user) => where.id.in.includes(user.id))
          .map((user) => ({ id: user.id, name: user.name })),
      ),
    },
    membership: {
      findUnique: vi.fn(async ({ where, select }: { where: { tenantId_userId: { tenantId: string; userId: string } }; select: Record<string, unknown> }) => {
        const key = where.tenantId_userId;
        const membership = memberships.find((row) => row.tenantId === key.tenantId && row.userId === key.userId);
        if (!membership) return null;
        if (select.role) return { role: membership.role, tenant: { ...tenantOf(membership.tenantId) } };
        return { id: membership.id };
      }),
      upsert: vi.fn(async ({ where, create }: { where: { tenantId_userId: { tenantId: string; userId: string } }; create: { tenantId: string; userId: string; role: Role }; update: object }) => {
        const key = where.tenantId_userId;
        const existing = memberships.find((row) => row.tenantId === key.tenantId && row.userId === key.userId);
        if (existing) return existing;
        const created = { id: nextId("m"), createdAt: NOW, ...create };
        memberships.push(created);
        return created;
      }),
    },
    tenantShareLink: {
      findMany: vi.fn(async ({ where, select, orderBy, take }: { where?: Record<string, unknown>; select?: Record<string, unknown>; orderBy?: { createdAt: "desc" }; take?: number }) => {
        let rows = links.filter((link) => matches(link, where));
        if (orderBy?.createdAt === "desc") rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (take) rows = rows.slice(0, take);
        return select ? rows.map((link) => presentLink(link, select)) : rows;
      }),
      findUnique: vi.fn(async ({ where, select }: { where: { id?: string; tokenHash?: string }; select?: Record<string, unknown> }) => {
        const link = links.find((row) => (where.tokenHash ? row.tokenHash === where.tokenHash : row.id === where.id));
        if (!link) return null;
        return select ? presentLink(link, select) : link;
      }),
      create: vi.fn(async ({ data, select }: { data: Omit<Link, "id" | "useCount" | "revokedAt" | "createdAt">; select?: Record<string, unknown> }) => {
        const row: Link = {
          id: nextId("link"),
          useCount: 0,
          revokedAt: null,
          createdAt: NOW,
          ...data,
        };
        links.push(row);
        return select ? presentLink(row, select) : row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: { useCount?: { increment?: number; decrement?: number }; revokedAt?: Date } }) => {
        const rows = links.filter((link) => matches(link, where));
        for (const row of rows) applyUseCount(row, data);
        return { count: rows.length };
      }),
    },
    tenantShareRedemption: {
      findUnique: vi.fn(async ({ where }: { where: { linkId_userId: { linkId: string; userId: string } } }) => {
        const key = where.linkId_userId;
        const row = redemptions.find((redemption) => redemption.linkId === key.linkId && redemption.userId === key.userId);
        return row ? { id: row.id } : null;
      }),
      create: vi.fn(async ({ data }: { data: { linkId: string; userId: string } }) => {
        if (redemptions.some((redemption) => redemption.linkId === data.linkId && redemption.userId === data.userId)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        const row = { id: nextId("red"), createdAt: NOW, ...data };
        redemptions.push(row);
        return row;
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const snap = {
        links: structuredClone(links),
        redemptions: structuredClone(redemptions),
        memberships: structuredClone(memberships),
      };
      try {
        return await fn(db);
      } catch (error) {
        links.splice(0, links.length, ...snap.links);
        redemptions.splice(0, redemptions.length, ...snap.redemptions);
        memberships.splice(0, memberships.length, ...snap.memberships);
        throw error;
      }
    }),
  };
  return db;
}

function setup() {
  const db = fakeDb();
  db.users.push({ id: "ada", name: "Ada" }, { id: "bob", name: "Bob" }, { id: "cara", name: "Cara" });
  db.tenants.push({ id: "acme", slug: "acme", name: "Acme" });
  db.memberships.push({ id: "m-ada", tenantId: "acme", userId: "ada", role: "owner", createdAt: NOW });
  return db;
}

function tokenFrom(url: string): string {
  return url.split("/join/")[1] ?? "";
}

async function create(
  db: ReturnType<typeof setup>,
  input: { expiresDays?: string; maxUses?: string; label?: string; userId?: string } = {},
) {
  return createShareLink(db as never, { id: input.userId ?? "ada" }, {
    tenantId: "acme",
    expiresDays: input.expiresDays ?? "7",
    maxUses: input.maxUses ?? "unlimited",
    label: input.label ?? "",
  }, NOW);
}

beforeEach(() => {
  process.env.AUTH_SECRET = "test-secret-that-is-long-enough";
});

describe("share link rules", () => {
  it("tells an open link from one that expired, filled up, or was revoked", () => {
    const base = { revokedAt: null, expiresAt: new Date(NOW.getTime() + DAY), maxUses: 1, useCount: 0 };
    expect(shareLinkState(base, NOW)).toBe("open");
    expect(shareLinkState({ ...base, useCount: 1 }, NOW)).toBe("used");
    expect(shareLinkState({ ...base, expiresAt: NOW }, NOW)).toBe("expired");
    expect(shareLinkState({ ...base, revokedAt: NOW }, NOW)).toBe("revoked");
  });

  it("counts the uses a link has left and the people beyond the listed names", () => {
    expect(shareLinkAudience({ maxUses: 10, useCount: 3 })).toMatch(/7 of 10/);
    expect(joinedSummary(["Ada", "Bob", "Cara", "Dee"], 6)).toMatch(/Ada.*Bob.*Cara.*3/);
    expect(joinedSummary(["Ada", "Bob", "Cara", "Dee"], 6)).not.toContain("Dee");
    expect(joinedSummary([], 0)).toBe("");
  });
});

describe("createShareLink", () => {
  it("lets an owner create a link without storing the raw token", async () => {
    const db = setup();
    const result = await create(db, { expiresDays: "7", maxUses: "1", label: "  Design team  " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raw = tokenFrom(result.url);
    expect(result.url).toBe(`https://ziki.dev/join/${raw}`);
    expect(result.maxUses).toBe(1);
    expect(result.expiresAt.getTime()).toBe(NOW.getTime() + 7 * DAY);
    expect(JSON.stringify(db.links)).not.toContain(raw);
    expect(db.links[0]?.tokenHash).toBe(hashInviteToken(raw));
    expect(openSecret(db.links[0]!.tokenEncrypted)).toBe(raw);
    expect(db.links[0]?.label).toBe("Design team");
  });

  it("refuses members, bad limits, a long note, and too many live links", async () => {
    const db = setup();
    db.memberships.push({ id: "m-bob", tenantId: "acme", userId: "bob", role: "member", createdAt: NOW });
    expect(await create(db, { userId: "bob" })).toMatchObject({ ok: false });

    expect(await create(db, { expiresDays: "14" })).toMatchObject({ ok: false, field: "expiresDays" });
    expect(await create(db, { maxUses: "2" })).toMatchObject({ ok: false, field: "maxUses" });
    expect(await create(db, { label: "x".repeat(61) })).toMatchObject({ ok: false, field: "label" });

    for (let i = 0; i < SHARE_LINK_ACTIVE_CAP; i++) await create(db);
    expect(await create(db)).toMatchObject({ ok: false, error: expect.stringContaining(String(SHARE_LINK_ACTIVE_CAP)) });
  });

  it("does not count an expired or full link toward the cap", async () => {
    const db = setup();
    const first = await create(db, { maxUses: "1" });
    expect(first.ok).toBe(true);
    db.links[0]!.expiresAt = new Date(NOW.getTime() - DAY);
    const second = await create(db, { maxUses: "unlimited" });
    expect(second.ok).toBe(true);
  });
});

describe("acceptShareLink", () => {
  it("adds the person who signs in, then stops a one-person link", async () => {
    const db = setup();
    const created = await create(db, { maxUses: "1" });
    if (!created.ok) throw new Error("create failed");
    const token = tokenFrom(created.url);

    const joined = await acceptShareLink(db as never, token, { id: "bob" }, NOW);
    expect(joined).toMatchObject({ ok: true, alreadyMember: false, tenant: { slug: "acme" } });
    expect(db.memberships.find((row) => row.userId === "bob")?.role).toBe("member");
    expect(db.links[0]?.useCount).toBe(1);

    const again = await acceptShareLink(db as never, token, { id: "cara" }, NOW);
    expect(again).toEqual({ ok: false, reason: "used" });
    expect(db.links[0]?.useCount).toBe(1);
    expect(db.memberships.some((row) => row.userId === "cara")).toBe(false);
  });

  it("does not spend a use when the person is already a member, or when they open it twice", async () => {
    const db = setup();
    const created = await create(db, { maxUses: "1" });
    if (!created.ok) throw new Error("create failed");
    const token = tokenFrom(created.url);

    const owner = await acceptShareLink(db as never, token, { id: "ada" }, NOW);
    expect(owner).toMatchObject({ ok: true, alreadyMember: true });
    expect(db.links[0]?.useCount).toBe(0);
    expect(db.memberships.find((row) => row.userId === "ada")?.role).toBe("owner");

    await acceptShareLink(db as never, token, { id: "bob" }, NOW);
    const second = await acceptShareLink(db as never, token, { id: "bob" }, NOW);
    expect(second).toMatchObject({ ok: true, alreadyMember: true });
    expect(db.links[0]?.useCount).toBe(1);
    expect(db.redemptions).toHaveLength(1);
  });

  it("lets anyone join until an unlimited link expires, and refuses a revoked one", async () => {
    const db = setup();
    const created = await create(db, { maxUses: "unlimited", expiresDays: "1" });
    if (!created.ok) throw new Error("create failed");
    const token = tokenFrom(created.url);

    for (const id of ["bob", "cara"]) {
      expect(await acceptShareLink(db as never, token, { id }, NOW)).toMatchObject({ ok: true });
    }
    expect(db.links[0]?.useCount).toBe(2);

    db.links[0]!.expiresAt = NOW;
    db.users.push({ id: "dee", name: "Dee" });
    expect(await acceptShareLink(db as never, token, { id: "dee" }, NOW)).toEqual({ ok: false, reason: "expired" });

    db.links[0]!.expiresAt = new Date(NOW.getTime() + DAY);
    expect((await revokeShareLink(db as never, { id: "ada" }, db.links[0]!.id, NOW)).ok).toBe(true);
    expect(await acceptShareLink(db as never, token, { id: "dee" }, NOW)).toEqual({ ok: false, reason: "revoked" });
  });

  it("repairs a redemption that did not finish adding the membership, without a second seat", async () => {
    const db = setup();
    const created = await create(db, { maxUses: "1" });
    if (!created.ok) throw new Error("create failed");
    const token = tokenFrom(created.url);
    db.links[0]!.useCount = 1;
    db.redemptions.push({ id: "red-bob", linkId: db.links[0]!.id, userId: "bob", createdAt: NOW });

    const joined = await acceptShareLink(db as never, token, { id: "bob" }, NOW);
    expect(joined).toMatchObject({ ok: true, alreadyMember: false });
    expect(db.links[0]?.useCount).toBe(1);
    expect(db.memberships.some((row) => row.userId === "bob")).toBe(true);
  });

  it("gives the seat back when the same person is recorded twice", async () => {
    const db = setup();
    const created = await create(db, { maxUses: "unlimited" });
    if (!created.ok) throw new Error("create failed");
    const token = tokenFrom(created.url);
    db.tenantShareRedemption.create.mockImplementationOnce(async () => {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    });

    const joined = await acceptShareLink(db as never, token, { id: "bob" }, NOW);
    expect(joined).toMatchObject({ ok: true, alreadyMember: false });
    expect(db.links[0]?.useCount).toBe(0);
    expect(db.memberships.some((row) => row.userId === "bob")).toBe(true);
  });

  it("rejects a token that is not a link", async () => {
    const db = setup();
    expect(await acceptShareLink(db as never, "nope", { id: "bob" }, NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(await previewShareLink(db as never, "nope")).toBeNull();
  });
});

describe("managing share links", () => {
  it("lists the link for copying, who joined, and lets an admin revoke it", async () => {
    const db = setup();
    db.memberships.push({ id: "m-cara", tenantId: "acme", userId: "cara", role: "admin", createdAt: NOW });
    const created = await create(db, { label: "Offsite", maxUses: "10" });
    if (!created.ok) throw new Error("create failed");
    await acceptShareLink(db as never, tokenFrom(created.url), { id: "bob" }, NOW);

    const [listed] = await listShareLinks(db as never, "acme", NOW);
    expect(listed?.url).toBe(created.url);
    expect(listed?.label).toBe("Offsite");
    expect(listed?.state).toBe("open");
    expect(listed?.joinedNames).toEqual(["Bob"]);
    expect(listed?.useCount).toBe(1);

    const preview = await previewShareLink(db as never, tokenFrom(created.url), { id: "ada" }, NOW);
    expect(preview).toMatchObject({ tenant: { name: "Acme" }, alreadyMember: true, state: "open" });
    expect(JSON.stringify(preview)).not.toContain("Offsite");

    db.memberships.push({ id: "m-bob", tenantId: "acme", userId: "bob", role: "member", createdAt: NOW });
    expect(await revokeShareLink(db as never, { id: "bob" }, db.links[0]!.id, NOW)).toMatchObject({ ok: false });
    expect((await revokeShareLink(db as never, { id: "cara" }, db.links[0]!.id, NOW)).ok).toBe(true);
    expect((await listShareLinks(db as never, "acme", NOW))[0]?.state).toBe("revoked");
  });

  it("still lists a link when someone who joined no longer has an account", async () => {
    const db = setup();
    const created = await create(db);
    if (!created.ok) throw new Error("create failed");
    db.redemptions.push({ id: "red-gone", linkId: db.links[0]!.id, userId: "gone", createdAt: NOW });
    db.links[0]!.useCount = 1;

    const [listed] = await listShareLinks(db as never, "acme", NOW);
    expect(listed?.url).toBe(created.url);
    expect(listed?.joinedNames).toEqual([]);
    expect(listed?.invitedByName).toBe("Ada");
  });

  it("hides a link whose stored token can no longer be opened", async () => {
    const db = setup();
    const created = await create(db);
    expect(created.ok).toBe(true);
    db.links[0]!.tokenEncrypted = "not-a-sealed-token";
    const [listed] = await listShareLinks(db as never, "acme", NOW);
    expect(listed?.url).toBeNull();
    expect(listed?.state).toBe("open");
  });
});
