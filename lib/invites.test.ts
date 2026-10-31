import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const notifyTenantInvite = vi.hoisted(() => vi.fn());
const mail = vi.hoisted(() => ({ canSendMail: vi.fn(() => true), sendMail: vi.fn() }));
const afterQueue = vi.hoisted(() => [] as Array<() => Promise<void> | void>);

vi.mock("@/lib/agent-notifications", () => ({ notifyTenantInvite }));
vi.mock("@/lib/mail", () => mail);
vi.mock("@/lib/site-url", () => ({ absoluteUrl: (path: string) => `https://ziki.dev${path}` }));
vi.mock("next/server", () => ({ after: (fn: () => Promise<void> | void) => afterQueue.push(fn) }));

import {
  INVITE_TTL_MS,
  acceptInvite,
  canInvite,
  createInvite,
  deliverInvite,
  generateInviteToken,
  hashInviteToken,
  inviteEmail,
  inviteState,
  maskEmail,
  destinationForInviteInput,
  parseInviteLink,
  openInvitesFor,
  pendingInvites,
  revokeInvite,
  viewInvite,
} from "./invites";

// ---------------------------------------------------------------------------
// A small in-memory stand-in for the Prisma calls lib/invites.ts makes. It
// keeps Postgres' semantics where they matter: unique (tenant, user)
// memberships and the conditional `updateMany` that makes a link single-use.
// ---------------------------------------------------------------------------

type Role = "owner" | "admin" | "member";
type User = { id: string; email: string; name: string };
type Tenant = { id: string; slug: string; name: string };
type Membership = { id: string; tenantId: string; userId: string; role: Role; createdAt: Date };
type Invite = {
  id: string;
  tenantId: string;
  email: string;
  role: Role;
  tokenHash: string;
  expiresAt: Date;
  invitedById: string;
  acceptedAt: Date | null;
  createdAt: Date;
};

type Where = Record<string, unknown>;

function inviteMatches(invite: Invite, where: Where): boolean {
  for (const [key, condition] of Object.entries(where)) {
    const value = invite[key as keyof Invite];
    if (condition && typeof condition === "object" && !(condition instanceof Date) && "gt" in condition) {
      if (!(value instanceof Date && value.getTime() > (condition.gt as Date).getTime())) return false;
    } else if (condition && typeof condition === "object" && !(condition instanceof Date) && "equals" in condition) {
      const expected = String((condition as { equals: unknown }).equals);
      const actual = String(value ?? "");
      const insensitive = (condition as { mode?: string }).mode === "insensitive";
      if (insensitive ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected) return false;
    } else if (value !== condition) {
      return false;
    }
  }
  return true;
}

function fakeDb() {
  const users: User[] = [];
  const tenants: Tenant[] = [];
  const memberships: Membership[] = [];
  const invites: Invite[] = [];
  let ids = 0;
  const nextId = (prefix: string) => `${prefix}-${++ids}`;

  const tenantOf = (id: string) => tenants.find((t) => t.id === id)!;
  const userOf = (id: string) => users.find((u) => u.id === id)!;
  const membershipFor = (tenantId: string, userId: string) =>
    memberships.find((m) => m.tenantId === tenantId && m.userId === userId);

  function selectInvite(invite: Invite, select: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(select)) {
      if (key === "tenant") out.tenant = { ...tenantOf(invite.tenantId) };
      else if (key === "invitedBy") out.invitedBy = { name: userOf(invite.invitedById).name };
      else out[key] = invite[key as keyof Invite];
    }
    return out;
  }

  const db = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { email: string } }) => {
        const user = users.find((u) => u.email === where.email);
        return user ? { id: user.id } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        users
          .filter((user) => where.id.in.includes(user.id))
          .map((user) => ({ id: user.id, name: user.name })),
      ),
    },
    membership: {
      findUnique: vi.fn(
        async ({ where, select }: { where: { tenantId_userId: { tenantId: string; userId: string } }; select: Record<string, unknown> }) => {
          const m = membershipFor(where.tenantId_userId.tenantId, where.tenantId_userId.userId);
          if (!m) return null;
          return {
            ...(select.id ? { id: m.id } : {}),
            ...(select.role ? { role: m.role } : {}),
            ...(select.tenant ? { tenant: { ...tenantOf(m.tenantId) } } : {}),
          };
        },
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { tenantId: string; user: { email: { equals: string; mode: string } } } }) => {
          const wanted = where.user.email.equals.toLowerCase();
          const m = memberships.find(
            (row) => row.tenantId === where.tenantId && userOf(row.userId).email.toLowerCase() === wanted,
          );
          return m ? { id: m.id } : null;
        },
      ),
      upsert: vi.fn(
        async ({ where, create }: { where: { tenantId_userId: { tenantId: string; userId: string } }; create: Omit<Membership, "id" | "createdAt"> }) => {
          const existing = membershipFor(where.tenantId_userId.tenantId, where.tenantId_userId.userId);
          if (existing) return existing;
          const row = { ...create, id: nextId("mem"), createdAt: new Date() };
          memberships.push(row);
          return row;
        },
      ),
    },
    tenantInvite: {
      create: vi.fn(async ({ data, select }: { data: Omit<Invite, "id" | "acceptedAt" | "createdAt">; select: Record<string, unknown> }) => {
        if (invites.some((i) => i.tokenHash === data.tokenHash)) throw Object.assign(new Error("unique"), { code: "P2002" });
        const row: Invite = { ...data, id: nextId("inv"), acceptedAt: null, createdAt: new Date(Date.now() + ids) };
        invites.push(row);
        return selectInvite(row, select);
      }),
      findUnique: vi.fn(async ({ where, select }: { where: { id?: string; tokenHash?: string }; select: Record<string, unknown> }) => {
        const row = invites.find((i) => (where.id ? i.id === where.id : i.tokenHash === where.tokenHash));
        return row ? selectInvite(row, select) : null;
      }),
      findMany: vi.fn(async ({ where, select }: { where: Where; select: Record<string, unknown> }) =>
        invites
          .filter((i) => inviteMatches(i, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((i) => selectInvite(i, select)),
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Invite> }) => {
        const rows = invites.filter((i) => inviteMatches(i, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const doomed = invites.filter((i) => inviteMatches(i, where));
        for (const row of doomed) invites.splice(invites.indexOf(row), 1);
        return { count: doomed.length };
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };

  return {
    db: db as never,
    raw: db,
    users,
    memberships,
    invites,
    addUser(email: string, name = email.split("@")[0]!) {
      const user = { id: nextId("user"), email, name };
      users.push(user);
      return user;
    },
    addTenant(slug: string, name: string) {
      const tenant = { id: nextId("tenant"), slug, name };
      tenants.push(tenant);
      return tenant;
    },
    join(tenant: Tenant, user: User, role: Role = "member") {
      memberships.push({ id: nextId("mem"), tenantId: tenant.id, userId: user.id, role, createdAt: new Date() });
    },
    roleOf(tenant: Tenant, user: User) {
      return membershipFor(tenant.id, user.id)?.role ?? null;
    },
  };
}

const NOW = new Date("2026-10-20T09:00:00Z");

function setup() {
  const store = fakeDb();
  const acme = store.addTenant("acme", "Acme");
  const owner = store.addUser("olu@acme.dev", "Olu Owner");
  const admin = store.addUser("ada@acme.dev", "Ada Admin");
  const member = store.addUser("mo@acme.dev", "Mo Member");
  const bob = store.addUser("bob@example.com", "Bob");
  const outsider = store.addUser("eve@example.com", "Eve");
  store.join(acme, owner, "owner");
  store.join(acme, admin, "admin");
  store.join(acme, member, "member");
  return { ...store, acme, owner, admin, member, bob, outsider };
}

async function invite(s: ReturnType<typeof setup>, email = "bob@example.com", now = NOW) {
  const result = await createInvite(s.db, s.owner, { tenantId: s.acme.id, email }, now);
  if (!result.ok) throw new Error(result.error);
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  afterQueue.length = 0;
  mail.canSendMail.mockReturnValue(true);
});

describe("invite tokens (#444)", () => {
  it("are random, and only their SHA-256 hash is meant to be kept", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.hash).toBe(createHash("sha256").update(a.raw).digest("hex"));
    expect(hashInviteToken(a.raw)).toBe(a.hash);
  });

  it("finds the token in a pasted link, a path or on its own, and nothing in junk", () => {
    const { raw } = generateInviteToken();
    expect(parseInviteLink(`https://ziki.dev/tenants/invite/${raw}`)).toBe(raw);
    expect(parseInviteLink(`  /tenants/invite/${raw}?utm=mail  `)).toBe(raw);
    expect(parseInviteLink(`https://ziki.dev/join/${raw}`)).toBe(raw);
    expect(parseInviteLink(raw)).toBe(raw);
    expect(parseInviteLink("https://ziki.dev/tenants/acme")).toBeNull();
    expect(parseInviteLink("/tenants/invite/short")).toBeNull();
    expect(parseInviteLink("")).toBeNull();
    expect(destinationForInviteInput(`https://ziki.dev/join/${raw}`)).toBe(`/join/${raw}`);
    expect(destinationForInviteInput(`/tenants/invite/${raw}`)).toBe(`/tenants/invite/${raw}`);
    expect(destinationForInviteInput(raw)).toBe(`/tenants/invite/${raw}`);
  });

  it("knows a pending, an accepted and an expired invite apart", () => {
    const expiresAt = new Date(NOW.getTime() + 1000);
    expect(inviteState({ acceptedAt: null, expiresAt }, NOW)).toBe("pending");
    expect(inviteState({ acceptedAt: NOW, expiresAt }, NOW)).toBe("accepted");
    expect(inviteState({ acceptedAt: null, expiresAt: NOW }, NOW)).toBe("expired");
  });

  it("masks the invited address down to its first letter and domain", () => {
    expect(maskEmail("bob@example.com")).toBe("b•••@example.com");
    expect(maskEmail("nonsense")).toBe("•••");
  });
});

describe("createInvite (#444)", () => {
  it("lets only a tenant's owners and admins invite", () => {
    expect(canInvite("owner")).toBe(true);
    expect(canInvite("admin")).toBe(true);
    expect(canInvite("member")).toBe(false);
    expect(canInvite(null)).toBe(false);
  });

  it("stores a hash of the link, never the link, expiring in 7 days, for a member", async () => {
    const s = setup();
    const result = await invite(s, "  Bob@Example.com ");

    expect(result.invite.email).toBe("bob@example.com");
    expect(s.invites).toHaveLength(1);
    const [row] = s.invites;
    expect(row!.tokenHash).toBe(hashInviteToken(result.rawToken));
    expect(JSON.stringify(s.invites)).not.toContain(result.rawToken);
    expect(row!.role).toBe("member");
    expect(row!.expiresAt.getTime() - NOW.getTime()).toBe(INVITE_TTL_MS);
    expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("lets an admin invite too", async () => {
    const s = setup();
    const result = await createInvite(s.db, s.admin, { tenantId: s.acme.id, email: "bob@example.com" }, NOW);
    expect(result.ok).toBe(true);
  });

  it("refuses an ordinary member, and someone outside the tenant, with the same words", async () => {
    const s = setup();
    const asMember = await createInvite(s.db, s.member, { tenantId: s.acme.id, email: "mo2@example.com" }, NOW);
    // An outsider can't invite themselves in, either.
    const asOutsider = await createInvite(s.db, s.outsider, { tenantId: s.acme.id, email: s.outsider.email }, NOW);
    const unknownTenant = await createInvite(s.db, s.owner, { tenantId: "tenant-nope", email: "x@example.com" }, NOW);

    expect(asMember).toEqual({ ok: false, error: expect.stringContaining("Only an owner or admin") });
    expect(asOutsider).toEqual(asMember);
    expect(unknownTenant).toEqual(asMember);
    expect(s.invites).toHaveLength(0);
  });

  it("rejects a bad address and someone who is already a member", async () => {
    const s = setup();
    expect(await createInvite(s.db, s.owner, { tenantId: s.acme.id, email: "not-an-email" }, NOW)).toMatchObject({
      ok: false,
      field: "email",
    });
    expect(await createInvite(s.db, s.owner, { tenantId: s.acme.id, email: "MO@acme.dev" }, NOW)).toMatchObject({
      ok: false,
      field: "email",
      error: "mo@acme.dev is already a member of Acme.",
    });
    expect(s.invites).toHaveLength(0);
  });

  it("replaces an earlier pending link for the same person", async () => {
    const s = setup();
    const first = await invite(s);
    const second = await invite(s);

    expect(s.invites).toHaveLength(1);
    expect(await acceptInvite(s.db, { token: first.rawToken }, s.bob, NOW)).toMatchObject({ ok: false, reason: "invalid" });
    expect(await acceptInvite(s.db, { token: second.rawToken }, s.bob, NOW)).toMatchObject({ ok: true });
  });
});

describe("acceptInvite (#444)", () => {
  it("adds the invited person as a member, once; the link then fails", async () => {
    const s = setup();
    const { rawToken } = await invite(s);

    const first = await acceptInvite(s.db, { token: rawToken }, s.bob, NOW);
    expect(first).toEqual({ ok: true, tenant: { id: s.acme.id, slug: "acme", name: "Acme" }, alreadyMember: false });
    expect(s.roleOf(s.acme, s.bob)).toBe("member");
    expect(s.invites[0]!.acceptedAt).toEqual(NOW);

    const again = await acceptInvite(s.db, { token: rawToken }, s.bob, NOW);
    expect(again).toMatchObject({ ok: false, reason: "used", error: expect.stringContaining("already used") });
    expect(s.memberships.filter((m) => m.userId === s.bob.id)).toHaveLength(1);
  });

  it("fails an expired link and adds nobody", async () => {
    const s = setup();
    const { rawToken } = await invite(s);
    const later = new Date(NOW.getTime() + INVITE_TTL_MS);

    const result = await acceptInvite(s.db, { token: rawToken }, s.bob, later);
    expect(result).toMatchObject({ ok: false, reason: "expired", error: expect.stringContaining("expired") });
    expect(s.roleOf(s.acme, s.bob)).toBeNull();
    expect(s.invites[0]!.acceptedAt).toBeNull();
  });

  it("works up to the last moment before it expires", async () => {
    const s = setup();
    const { rawToken } = await invite(s);
    const justBefore = new Date(NOW.getTime() + INVITE_TTL_MS - 1);
    expect(await acceptInvite(s.db, { token: rawToken }, s.bob, justBefore)).toMatchObject({ ok: true });
  });

  it("fails a link that was never issued", async () => {
    const s = setup();
    await invite(s);
    const forged = generateInviteToken().raw;
    expect(await acceptInvite(s.db, { token: forged }, s.bob, NOW)).toMatchObject({ ok: false, reason: "invalid" });
    expect(await acceptInvite(s.db, { token: "../../etc" }, s.bob, NOW)).toMatchObject({ ok: false, reason: "invalid" });
    expect(s.roleOf(s.acme, s.bob)).toBeNull();
  });

  it("is only for the invited address: a forwarded link lets nobody else in, and isn't used up", async () => {
    const s = setup();
    const { rawToken } = await invite(s);

    const stolen = await acceptInvite(s.db, { token: rawToken }, s.outsider, NOW);
    expect(stolen).toMatchObject({ ok: false, reason: "wrong_account" });
    expect(s.roleOf(s.acme, s.outsider)).toBeNull();
    expect(s.invites[0]!.acceptedAt).toBeNull();

    expect(await acceptInvite(s.db, { token: rawToken }, { ...s.bob, email: "BOB@example.com" }, NOW)).toMatchObject({
      ok: true,
    });
  });

  it("lets exactly one of two racing clicks through", async () => {
    const s = setup();
    const { rawToken } = await invite(s);
    const results = await Promise.all([
      acceptInvite(s.db, { token: rawToken }, s.bob, NOW),
      acceptInvite(s.db, { token: rawToken }, s.bob, NOW),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ reason: "used" });
    expect(s.memberships.filter((m) => m.userId === s.bob.id)).toHaveLength(1);
  });

  it("accepts from the in-app notification by id, for the invited account only", async () => {
    const s = setup();
    const { invite: created } = await invite(s);

    // Someone else's invite looks the same as none at all.
    expect(await acceptInvite(s.db, { inviteId: created.id }, s.outsider, NOW)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(await acceptInvite(s.db, { inviteId: "inv-nope" }, s.bob, NOW)).toMatchObject({ ok: false, reason: "invalid" });
    expect(await acceptInvite(s.db, { inviteId: created.id }, s.bob, NOW)).toMatchObject({ ok: true });
    expect(s.roleOf(s.acme, s.bob)).toBe("member");
  });

  it("never lowers the role of someone already in the tenant", async () => {
    const s = setup();
    // Bob became an admin some other way after being invited.
    const { rawToken } = await invite(s);
    s.join(s.acme, s.bob, "admin");

    const result = await acceptInvite(s.db, { token: rawToken }, s.bob, NOW);
    expect(result).toMatchObject({ ok: true, alreadyMember: true });
    expect(s.roleOf(s.acme, s.bob)).toBe("admin");
  });
});

describe("viewInvite (#444)", () => {
  it("shows the invited account who invited them, to what", async () => {
    const s = setup();
    const { rawToken } = await invite(s);
    expect(await viewInvite(s.db, { token: rawToken }, s.bob, NOW)).toEqual({
      id: s.invites[0]!.id,
      state: "pending",
      expiresAt: s.invites[0]!.expiresAt,
      maskedEmail: "b•••@example.com",
      forThisAccount: true,
      details: {
        tenant: { id: s.acme.id, slug: "acme", name: "Acme" },
        invitedByName: "Olu Owner",
        alreadyMember: false,
      },
    });
  });

  it("names no tenant and no inviter to anyone else holding the link", async () => {
    const s = setup();
    const { rawToken } = await invite(s);
    const view = await viewInvite(s.db, { token: rawToken }, s.outsider, NOW);
    expect(view).toMatchObject({ forThisAccount: false, details: null, maskedEmail: "b•••@example.com" });
    expect(JSON.stringify(view)).not.toContain("Acme");
    expect(JSON.stringify(view)).not.toContain("Olu");
  });

  it("by id, hides someone else's invite completely", async () => {
    const s = setup();
    const { invite: created } = await invite(s);
    expect(await viewInvite(s.db, { inviteId: created.id }, s.outsider, NOW)).toBeNull();
    expect(await viewInvite(s.db, { inviteId: created.id }, s.bob, NOW)).toMatchObject({ forThisAccount: true });
  });

  it("reports a used or expired invite", async () => {
    const s = setup();
    const { rawToken } = await invite(s);
    expect(await viewInvite(s.db, { token: rawToken }, s.bob, new Date(NOW.getTime() + INVITE_TTL_MS))).toMatchObject({
      state: "expired",
    });
    await acceptInvite(s.db, { token: rawToken }, s.bob, NOW);
    expect(await viewInvite(s.db, { token: rawToken }, s.bob, NOW)).toMatchObject({
      state: "accepted",
      details: { alreadyMember: true },
    });
  });
});

describe("openInvitesFor", () => {
  it("lists a live invite for this account so they can join without the link", async () => {
    const s = setup();
    const created = await invite(s, "Bob@example.com");
    const open = await openInvitesFor(s.db, s.bob, NOW);
    expect(open).toEqual([
      {
        id: created.invite.id,
        expiresAt: created.invite.expiresAt,
        tenant: { id: s.acme.id, name: "Acme", slug: "acme" },
        invitedByName: "Olu Owner",
      },
    ]);
  });

  it("hides an invite once they are already in that tenant, and ignores other people", async () => {
    const s = setup();
    await invite(s);
    s.join(s.acme, s.bob, "member");
    expect(await openInvitesFor(s.db, s.bob, NOW)).toEqual([]);
    expect(await openInvitesFor(s.db, s.outsider, NOW)).toEqual([]);
  });
});

describe("pendingInvites and revokeInvite (#444)", () => {
  it("lists only links still waiting, newest first", async () => {
    const s = setup();
    const accepted = await invite(s, "bob@example.com");
    await acceptInvite(s.db, { token: accepted.rawToken }, s.bob, NOW);
    await invite(s, "old@example.com", new Date(NOW.getTime() - INVITE_TTL_MS - 1));
    await invite(s, "new@example.com");

    const pending = await pendingInvites(s.db, s.acme.id, NOW);
    expect(pending.map((p) => [p.email, p.invitedByName])).toEqual([["new@example.com", "Olu Owner"]]);
  });

  it("lets an owner or admin withdraw a link, which then fails", async () => {
    const s = setup();
    const { rawToken, invite: created } = await invite(s);
    expect(await revokeInvite(s.db, s.admin, created.id)).toEqual({ ok: true, tenantSlug: "acme" });
    expect(await acceptInvite(s.db, { token: rawToken }, s.bob, NOW)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("refuses members and outsiders alike, and keeps accepted invites", async () => {
    const s = setup();
    const { rawToken, invite: created } = await invite(s);
    const asMember = await revokeInvite(s.db, s.member, created.id);
    expect(asMember).toEqual({ ok: false, error: expect.stringContaining("Only an owner or admin") });
    expect(await revokeInvite(s.db, s.outsider, created.id)).toEqual(asMember);
    expect(await revokeInvite(s.db, s.owner, "inv-nope")).toEqual(asMember);

    await acceptInvite(s.db, { token: rawToken }, s.bob, NOW);
    expect(await revokeInvite(s.db, s.owner, created.id)).toEqual({
      ok: false,
      error: "That invite was already accepted.",
    });
    expect(s.invites).toHaveLength(1);
  });
});

describe("deliverInvite (#444)", () => {
  it("tells someone with an account in Ziki, and doesn't email them a second link", async () => {
    const s = setup();
    const created = await invite(s);
    const delivery = await deliverInvite(s.db, {
      invite: created.invite,
      rawToken: created.rawToken,
      tenantName: "Acme",
      inviter: { id: s.owner.id, name: "Olu Owner" },
    });

    expect(delivery).toBe("notified");
    expect(notifyTenantInvite).toHaveBeenCalledWith({
      id: created.invite.id,
      tenantName: "Acme",
      email: "bob@example.com",
      invitedBy: { id: s.owner.id, name: "Olu Owner" },
    });
    expect(afterQueue).toHaveLength(0);
  });

  it("emails the link to someone without an account, after the response", async () => {
    const s = setup();
    const created = await invite(s, "new@example.com");
    const delivery = await deliverInvite(s.db, {
      invite: created.invite,
      rawToken: created.rawToken,
      tenantName: "Acme",
      inviter: { id: s.owner.id, name: "Olu Owner" },
    });

    expect(delivery).toBe("emailed");
    expect(mail.sendMail).not.toHaveBeenCalled();
    await afterQueue[0]!();
    expect(mail.sendMail).toHaveBeenCalledWith({
      to: "new@example.com",
      subject: "[Ziki Issues] Olu Owner invited you to Acme",
      text: expect.stringContaining(`https://ziki.dev/tenants/invite/${created.rawToken}`),
    });
  });

  it("never logs the link when the email fails", async () => {
    const s = setup();
    const created = await invite(s, "new@example.com");
    mail.sendMail.mockRejectedValueOnce(new Error("SMTP down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await deliverInvite(s.db, {
      invite: created.invite,
      rawToken: created.rawToken,
      tenantName: "Acme",
      inviter: { id: s.owner.id, name: "Olu Owner" },
    });
    await afterQueue[0]!();
    expect(logged).toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).not.toContain(created.rawToken);
    logged.mockRestore();
  });

  it("leaves it to the inviter when this site can't send email", async () => {
    const s = setup();
    mail.canSendMail.mockReturnValue(false);
    const created = await invite(s, "new@example.com");
    expect(
      await deliverInvite(s.db, {
        invite: created.invite,
        rawToken: created.rawToken,
        tenantName: "Acme",
        inviter: { id: s.owner.id, name: "Olu Owner" },
      }),
    ).toBe("manual");
    expect(afterQueue).toHaveLength(0);
  });

  it("says who invited them, where, and for how long the link works", () => {
    const { subject, text } = inviteEmail({
      inviterName: "Olu",
      tenantName: "Acme",
      email: "new@example.com",
      link: "https://ziki.dev/tenants/invite/abc",
    });
    expect(subject).toContain("Olu");
    expect(subject).toContain("Acme");
    expect(text).toContain("https://ziki.dev/tenants/invite/abc");
    expect(text).toMatch(/\b7 days\b/);
    expect(text).toContain("new@example.com");
  });
});
