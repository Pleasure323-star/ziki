import { beforeEach, describe, expect, it, vi } from "vitest";

class Redirect extends Error {
  constructor(public readonly path: string) {
    super(`NEXT_REDIRECT ${path}`);
  }
}

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  redirect: vi.fn(),
  revalidatePath: vi.fn(),
  setActiveProjectCookie: vi.fn(),
  consumeRateLimit: vi.fn(),
  memberTenantById: vi.fn(),
  createTenant: vi.fn(),
  setActiveTenantCookie: vi.fn(),
  promoteFirstZeduOwner: vi.fn(),
  createInvite: vi.fn(),
  deliverInvite: vi.fn(),
  acceptInvite: vi.fn(),
  revokeInvite: vi.fn(),
  renameTenant: vi.fn(),
  setTenantArchived: vi.fn(),
  deleteTenant: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
  unstable_cache: vi.fn((fn) => fn),
}));
vi.mock("@/lib/project-context", () => ({ setActiveProjectCookie: mocks.setActiveProjectCookie }));
vi.mock("@/lib/rate-limit", () => ({
  RATE_LIMIT_MESSAGE: "You're doing that too fast. Please wait a moment.",
  consumeRateLimit: mocks.consumeRateLimit,
}));
vi.mock("@/lib/site-url", () => ({ absoluteUrl: (path: string) => `https://ziki.dev${path}` }));
vi.mock("@/lib/tenants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenants")>()),
  memberTenantById: mocks.memberTenantById,
  createTenant: mocks.createTenant,
  setActiveTenantCookie: mocks.setActiveTenantCookie,
  promoteFirstZeduOwner: mocks.promoteFirstZeduOwner,
  renameTenant: mocks.renameTenant,
  setTenantArchived: mocks.setTenantArchived,
  deleteTenant: mocks.deleteTenant,
}));
vi.mock("@/lib/invites", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/invites")>()),
  createInvite: mocks.createInvite,
  deliverInvite: mocks.deliverInvite,
  acceptInvite: mocks.acceptInvite,
  revokeInvite: mocks.revokeInvite,
}));
// lib/invites pulls these in; nothing here should reach them.
vi.mock("@/lib/agent-notifications", () => ({ notifyTenantInvite: vi.fn() }));
vi.mock("@/lib/mail", () => ({ canSendMail: vi.fn(), sendMail: vi.fn() }));

import {
  acceptInviteAction,
  createInviteAction,
  createTenantAction,
  deleteTenantAction,
  openInviteLinkAction,
  promoteZeduOwnerAction,
  renameTenantAction,
  revokeInviteAction,
  selectTenantAction,
  setTenantArchivedAction,
} from "./actions";

const ADA = { id: "ada", name: "Ada", email: "ada@acme.dev", role: "user" as const };
const ACME = { id: "tenant-acme", slug: "acme", name: "Acme" };
const TOKEN = "A".repeat(43);

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function redirectedTo(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Redirect) return error.path;
    throw error;
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(ADA);
  mocks.redirect.mockImplementation((path: string) => {
    throw new Redirect(path);
  });
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
});

describe("selectTenantAction (#444)", () => {
  it("opens a tenant the person belongs to", async () => {
    mocks.memberTenantById.mockResolvedValue({ ...ACME, role: "member" });
    expect(await redirectedTo(() => selectTenantAction(form({ tenantId: ACME.id })))).toBe("/issues");
    expect(mocks.memberTenantById).toHaveBeenCalledWith({}, "ada", ACME.id);
    expect(mocks.setActiveTenantCookie).toHaveBeenCalledWith(ACME.id);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("ignores a tenant they aren't in, without saying whether it exists", async () => {
    mocks.memberTenantById.mockResolvedValue(null);
    expect(await redirectedTo(() => selectTenantAction(form({ tenantId: "tenant-zedu" })))).toBe("/tenants");
    expect(mocks.setActiveTenantCookie).not.toHaveBeenCalled();
  });

  it("doesn't open an archived tenant (#573)", async () => {
    mocks.memberTenantById.mockResolvedValue({
      ...ACME,
      role: "member",
      archivedAt: new Date("2026-10-01"),
    });
    const path = await redirectedTo(() =>
      selectTenantAction(form({ tenantId: ACME.id })),
    );
    expect(path).toContain("/tenants?error=");
    expect(mocks.setActiveTenantCookie).not.toHaveBeenCalled();
  });
});

describe("tenant lifecycle actions (#573)", () => {
  const OWNER = { ...ACME, role: "owner" as const, archivedAt: null };

  beforeEach(() => {
    mocks.memberTenantById.mockResolvedValue(OWNER);
  });

  it("renames a tenant and returns to the organization's settings tab", async () => {
    mocks.renameTenant.mockResolvedValue({ ok: true, tenant: OWNER });
    const path = await redirectedTo(() =>
      renameTenantAction(form({ tenantId: ACME.id, name: "Acme Corp" })),
    );

    expect(path).toBe("/org/settings?notice=Organization%20renamed.");
    expect(mocks.renameTenant).toHaveBeenCalledWith({}, "ada", ACME.id, "Acme Corp");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("shows a rename refusal on the organization's settings tab", async () => {
    mocks.renameTenant.mockResolvedValue({ ok: false, error: "Only the tenant's owner can rename it." });
    const path = await redirectedTo(() =>
      renameTenantAction(form({ tenantId: ACME.id, name: "Acme Corp" })),
    );

    expect(path).toContain("/org/settings?error=");
    expect(decodeURIComponent(path)).toContain("Only the tenant's owner can rename it.");
  });

  it("archives and restores a tenant", async () => {
    mocks.setTenantArchived.mockResolvedValue({ ok: true, tenant: OWNER });

    expect(
      await redirectedTo(() =>
        setTenantArchivedAction(form({ tenantId: ACME.id, archived: "true" })),
      ),
    ).toBe("/tenants?notice=Organization%20archived.");
    expect(mocks.setTenantArchived).toHaveBeenCalledWith({}, "ada", ACME.id, true);

    expect(
      await redirectedTo(() =>
        setTenantArchivedAction(form({ tenantId: ACME.id, archived: "false" })),
      ),
    ).toBe("/tenants?notice=Organization%20restored.");
    expect(mocks.setTenantArchived).toHaveBeenLastCalledWith({}, "ada", ACME.id, false);
  });

  it("shows an archive refusal in /org, and a restore refusal on the picker", async () => {
    mocks.setTenantArchived.mockResolvedValue({ ok: false, error: "Only the tenant's owner can archive it." });
    expect(
      await redirectedTo(() =>
        setTenantArchivedAction(form({ tenantId: ACME.id, archived: "true" })),
      ),
    ).toContain("/org/settings?error=");
    expect(
      await redirectedTo(() =>
        setTenantArchivedAction(form({ tenantId: ACME.id, archived: "false" })),
      ),
    ).toContain("/tenants?error=");
  });

  it("deletes a tenant after the confirmation, and reports a refusal", async () => {
    mocks.deleteTenant.mockResolvedValue({ ok: true, tenant: OWNER });
    expect(
      await redirectedTo(() =>
        deleteTenantAction(form({ tenantId: ACME.id, confirmName: ACME.name })),
      ),
    ).toBe("/tenants?notice=Organization%20deleted.");
    expect(mocks.deleteTenant).toHaveBeenCalledWith({}, "ada", ACME.id, ACME.name);

    mocks.deleteTenant.mockResolvedValue({ ok: false, error: "This tenant still has issues." });
    const path = await redirectedTo(() =>
      deleteTenantAction(form({ tenantId: ACME.id, confirmName: ACME.name })),
    );
    expect(path).toContain("/org/settings?error=");
  });
});

describe("createTenantAction (#444)", () => {
  it("creates the tenant, enters it and its first project", async () => {
    mocks.createTenant.mockResolvedValue({ ok: true, tenant: ACME, projectId: "project-acme" });
    const path = await redirectedTo(() =>
      createTenantAction(undefined, form({ name: "Acme", projectName: "" })),
    );

    expect(path).toBe("/issues");
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith("tenant-create:ada", expect.any(Object));
    expect(mocks.createTenant).toHaveBeenCalledWith({}, ADA, { name: "Acme", projectName: "" });
    expect(mocks.setActiveTenantCookie).toHaveBeenCalledWith(ACME.id);
    expect(mocks.setActiveProjectCookie).toHaveBeenCalledWith("project-acme");
  });

  it("points at the field to fix, without counting a typo against the limit", async () => {
    const result = await createTenantAction(undefined, form({ name: "A" }));
    expect(result).toMatchObject({ field: "name", error: expect.any(String) });
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.createTenant).not.toHaveBeenCalled();
  });

  it("passes the duplicate-name warning back, and the confirmation on (#537)", async () => {
    mocks.createTenant.mockResolvedValueOnce({
      ok: false,
      field: "name",
      duplicateName: "Acme",
      error: "You're already in an organization called \"Acme\" (acme).",
    });
    expect(await createTenantAction(undefined, form({ name: "Acme" }))).toMatchObject({
      field: "name",
      duplicateName: "Acme",
      fieldErrors: { name: expect.stringContaining("already in an organization") },
    });

    mocks.createTenant.mockResolvedValueOnce({ ok: true, tenant: ACME, projectId: "project-acme" });
    await redirectedTo(() => createTenantAction(undefined, form({ name: "Acme", confirmDuplicate: "Acme" })));
    expect(mocks.createTenant).toHaveBeenLastCalledWith({}, ADA, { name: "Acme", projectName: "", confirmDuplicate: "Acme" });
  });

  it("stops someone creating tenants too fast", async () => {
    mocks.consumeRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    expect(await createTenantAction(undefined, form({ name: "Acme" }))).toEqual({
      error: "You're doing that too fast. Please wait a moment.",
    });
    expect(mocks.createTenant).not.toHaveBeenCalled();
  });
});

describe("createInviteAction (#444)", () => {
  const created = {
    ok: true,
    invite: { id: "inv-1", email: "bob@example.com", expiresAt: new Date("2026-10-27T09:00:00Z") },
    tenant: ACME,
    rawToken: TOKEN,
  };

  it("returns the link once, and how the invitee hears of it", async () => {
    mocks.createInvite.mockResolvedValue(created);
    mocks.deliverInvite.mockResolvedValue("emailed");

    const result = await createInviteAction(undefined, form({ tenantId: ACME.id, email: "bob@example.com" }));
    expect(result).toEqual({
      ok: true,
      email: "bob@example.com",
      link: `https://ziki.dev/tenants/invite/${TOKEN}`,
      expiresAt: "2026-10-27T09:00:00.000Z",
      delivery: "emailed",
    });
    expect(mocks.createInvite).toHaveBeenCalledWith({}, ADA, { tenantId: ACME.id, email: "bob@example.com" });
    expect(mocks.deliverInvite).toHaveBeenCalledWith({}, {
      invite: created.invite,
      rawToken: TOKEN,
      tenantId: ACME.id,
      tenantName: "Acme",
      inviter: { id: "ada", name: "Ada" },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/org/invites");
  });

  it("still hands over the link when telling the invitee fails", async () => {
    mocks.createInvite.mockResolvedValue(created);
    mocks.deliverInvite.mockRejectedValue(new Error("db down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await createInviteAction(undefined, form({ tenantId: ACME.id, email: "bob@example.com" }));
    expect(result).toMatchObject({ ok: true, delivery: "manual" });
    expect(JSON.stringify(logged.mock.calls)).not.toContain(TOKEN);
    logged.mockRestore();
  });

  it("passes on a refusal", async () => {
    mocks.createInvite.mockResolvedValue({ ok: false, error: "Only an owner or admin of this tenant can manage its invites." });
    expect(await createInviteAction(undefined, form({ tenantId: ACME.id, email: "x@example.com" }))).toMatchObject({
      ok: false,
    });
    expect(mocks.deliverInvite).not.toHaveBeenCalled();
  });

  it("stops someone sending invites too fast", async () => {
    mocks.consumeRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    expect(await createInviteAction(undefined, form({ tenantId: ACME.id, email: "x@example.com" }))).toMatchObject({
      ok: false,
    });
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });
});

describe("acceptInviteAction (#444)", () => {
  it("joins by link and enters the tenant", async () => {
    mocks.acceptInvite.mockResolvedValue({ ok: true, tenant: ACME, alreadyMember: false });
    expect(await redirectedTo(() => acceptInviteAction(undefined, form({ token: TOKEN })))).toBe("/issues");
    expect(mocks.acceptInvite).toHaveBeenCalledWith({}, { token: TOKEN }, ADA);
    expect(mocks.setActiveTenantCookie).toHaveBeenCalledWith(ACME.id);
  });

  it("joins from an in-app notification by the invite's id", async () => {
    mocks.acceptInvite.mockResolvedValue({ ok: true, tenant: ACME, alreadyMember: false });
    await redirectedTo(() => acceptInviteAction(undefined, form({ inviteId: "inv-1" })));
    expect(mocks.acceptInvite).toHaveBeenCalledWith({}, { inviteId: "inv-1" }, ADA);
  });

  it("explains a used or expired link and enters nothing", async () => {
    mocks.acceptInvite.mockResolvedValue({ ok: false, reason: "expired", error: "This invite has expired." });
    expect(await acceptInviteAction(undefined, form({ token: TOKEN }))).toEqual({ error: "This invite has expired." });
    expect(mocks.setActiveTenantCookie).not.toHaveBeenCalled();
  });
});

describe("the other tenant actions (#444)", () => {
  it("opens a pasted invite link, and rejects anything else", async () => {
    expect(
      await redirectedTo(() => openInviteLinkAction(undefined, form({ link: `https://ziki.dev/tenants/invite/${TOKEN}` }))),
    ).toBe(`/tenants/invite/${TOKEN}`);
    expect(
      await redirectedTo(() => openInviteLinkAction(undefined, form({ link: `https://ziki.dev/join/${TOKEN}` }))),
    ).toBe(`/join/${TOKEN}`);
    expect(await openInviteLinkAction(undefined, form({ link: "https://ziki.dev/tenants/zedu" }))).toMatchObject({
      field: "link",
    });
  });

  it("revokes as the signed-in person and refreshes the organization's invites tab", async () => {
    mocks.revokeInvite.mockResolvedValue({ ok: true, tenantSlug: "acme" });
    await revokeInviteAction(form({ inviteId: "inv-1" }));
    expect(mocks.revokeInvite).toHaveBeenCalledWith({}, ADA, "inv-1");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/org/invites");
  });

  it("asks lib/tenants whether this person may choose Zedu's owner", async () => {
    mocks.promoteFirstZeduOwner.mockResolvedValue({ ok: false, error: "Only the site's super admin can choose Zedu's first owner." });
    expect(await promoteZeduOwnerAction(undefined, form({ email: "lead@zedu.chat" }))).toMatchObject({ ok: false });
    expect(mocks.promoteFirstZeduOwner).toHaveBeenCalledWith({}, ADA, "lead@zedu.chat");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
