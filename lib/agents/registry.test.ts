import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const mock = {
    agent: { create: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findFirst: vi.fn(async (): Promise<{ id: string } | null> => null), update: vi.fn(), delete: vi.fn(), count: vi.fn(async () => 0) },
    agentApiKey: { create: vi.fn(), updateMany: vi.fn() },
    agentAreaPreference: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    projectArea: { findMany: vi.fn() },
    agentAuditEvent: { create: vi.fn() },
    membership: { findMany: vi.fn(), findUnique: vi.fn() },
    project: { findFirst: vi.fn() },
    issueClaim: { findMany: vi.fn(async () => []) },
    issueBid: { updateMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(),
  };
  mock.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mock));
  return mock;
});
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { hashSecret } from "./keys";
import { openSecret } from "@/lib/secret-box";
import { createAgent, deleteAgent, regenerateKey, renameAgent, revokeAgent, rotateKey, setAgentAreaPreferences, setAgentAvatar, setAgentBurst, setAgentLevel } from "./registry";
import { MAX_ACTIVE_AGENTS_PER_OWNER } from "./registry-limits";

const ada = { id: "ada", role: "user" as const };
const zedu = [{ tenantId: "tenant_zedu", role: "member", tenant: { slug: "zedu" } }];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = "test-secret-at-least-16";
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  db.membership.findMany.mockResolvedValue(zedu);
  db.membership.findUnique.mockResolvedValue({ role: "member" });
  db.project.findFirst.mockResolvedValue({ id: "project_web", slug: "web", name: "Web" });
  db.agent.create.mockImplementation(async ({ data }: { data: { name: string } }) => ({ id: "agent1", name: data.name }));
});

describe("createAgent (#427)", () => {
  it.each(["manager", "merger"] as const)("requires tenant admin authority to create a %s", async (level) => {
    expect(await createAgent(ada, { name: "Privileged agent", level, projectId: "project_web" })).toMatchObject({ ok: false, field: "level" });
    expect(db.agent.create).not.toHaveBeenCalled();
    db.membership.findUnique.mockResolvedValue({ role: "admin" });
    expect(await createAgent(ada, { name: "Privileged agent", level, projectId: "project_web" })).toMatchObject({ ok: true });
    expect(db.agent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ level }) }));
  });
  it("returns the raw key and seals it so the owner can copy it again", async () => {
    const result = await createAgent(ada, { name: "  Ada's   Claude ", model: "Claude", projectId: "project_web" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { data } = db.agent.create.mock.calls[0][0];
    expect(data).toMatchObject({
      tenantId: "tenant_zedu",
      ownerUserId: "ada",
      name: "Ada's Claude",
      model: "Claude",
      level: "working",
    });
    const stored = data.apiKeys.create;
    expect(stored).toMatchObject({
      keyHash: hashSecret(result.key.rawKey),
      prefix: result.key.prefix,
      projectId: "project_web",
    });
    expect(openSecret(stored.sealedKey)).toBe(result.key.rawKey);
    expect(JSON.stringify(data)).not.toContain(result.key.rawKey);
    expect(db.agentAuditEvent.create.mock.calls[0][0].data).toMatchObject({
      agentId: "agent1",
      action: "agent.created",
      actorUserId: "ada",
    });
  });

  it("lets the owner start an agent as a working agent, but no higher", async () => {
    await createAgent(ada, { name: "Ada's GPT", level: "working", projectId: "project_web" });
    expect(db.agent.create.mock.calls[0][0].data.level).toBe("working");
    const result = await createAgent(ada, { name: "Ada's GPT", level: "manager", projectId: "project_web" });
    expect(result).toMatchObject({ ok: false, field: "level" });
  });

  it("names the field when the name is missing", async () => {
    expect(await createAgent(ada, { name: " " })).toMatchObject({ ok: false, field: "name" });
    expect(db.agent.create).not.toHaveBeenCalled();
  });

  it("refuses someone who isn't in a tenant", async () => {
    db.membership.findMany.mockResolvedValue([]);
    expect(await createAgent(ada, { name: "Ada's Claude", projectId: "project_web" })).toMatchObject({ ok: false });
    expect(db.agent.create).not.toHaveBeenCalled();
  });

  it("refuses a project outside the workspace (#742)", async () => {
    db.project.findFirst.mockResolvedValue(null);
    expect(await createAgent(ada, { name: "Ada's Claude", projectId: "project_other" })).toMatchObject({
      ok: false,
      field: "projectId",
    });
    expect(db.agent.create).not.toHaveBeenCalled();
  });
});

const agentRow = { id: "agent1", name: "Ada's Claude", tenantId: "tenant_zedu", ownerUserId: "ada", revokedAt: null };

describe("revokeAgent and setAgentLevel (#427)", () => {
  it("lets the owner revoke, which revokes every key", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    expect(await revokeAgent(ada, "agent1")).toEqual({ ok: true });
    expect(db.agent.update.mock.calls[0][0].data.revokedAt).toBeInstanceOf(Date);
    expect(db.agentApiKey.updateMany.mock.calls[0][0].where).toEqual({ agentId: "agent1", revokedAt: null });
    expect(db.agentAuditEvent.create.mock.calls[0][0].data.payload).toEqual({ by: "owner", releasedClaims: 0, withdrawnBids: 0 });
  });

  it("lets a tenant admin revoke someone else's agent", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    db.membership.findUnique.mockResolvedValue({ role: "admin" });
    expect(await revokeAgent({ id: "lead", role: "user" }, "agent1")).toEqual({ ok: true });
    expect(db.agentAuditEvent.create.mock.calls[0][0].data.payload).toEqual({ by: "tenant_admin", releasedClaims: 0, withdrawnBids: 0 });
  });

  it("refuses anyone else", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    expect(await revokeAgent({ id: "bob", role: "user" }, "agent1")).toMatchObject({ ok: false });
    expect(db.agent.update).not.toHaveBeenCalled();
  });

  it("lets the owner delete the agent after handing its work back", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    expect(await deleteAgent(ada, "agent1")).toEqual({ ok: true });
    expect(db.issueClaim.findMany).toHaveBeenCalled();
    expect(db.agent.delete).toHaveBeenCalledWith({ where: { id: "agent1" } });
  });

  it("refuses a delete from anyone else", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    expect(await deleteAgent({ id: "bob", role: "user" }, "agent1")).toMatchObject({ ok: false });
    expect(db.agent.delete).not.toHaveBeenCalled();
  });

  it("lets the owner set working but not manager or merger", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    db.agent.findUniqueOrThrow.mockResolvedValue({ level: "manager" });
    expect(await setAgentLevel(ada, "agent1", "working")).toEqual({ ok: true });
    expect(db.agent.update.mock.calls[0][0].data).toEqual({ level: "working", levelChangedAt: expect.any(Date) });
    expect(await setAgentLevel(ada, "agent1", "merger")).toMatchObject({ ok: false });
    expect(await setAgentLevel(ada, "agent1", "manager")).toMatchObject({ ok: false });
    expect(db.agent.update).toHaveBeenCalledTimes(1);
  });

  it("lets a site super admin set merger on someone else's agent", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    db.agent.findUniqueOrThrow.mockResolvedValue({ level: "working" });
    expect(await setAgentLevel({ id: "root", role: "super_admin" }, "agent1", "merger")).toEqual({ ok: true });
    expect(db.agent.update.mock.calls[0][0].data).toEqual({ level: "merger", levelChangedAt: expect.any(Date) });
    expect(db.membership.findUnique).not.toHaveBeenCalled();
  });
});

describe("setAgentBurst (#440)", () => {
  it("lets a workspace admin raise the write budget", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    db.membership.findUnique.mockResolvedValue({ role: "admin" });
    db.agent.findUniqueOrThrow.mockResolvedValue({ burst: false, burstUntil: null });
    expect(await setAgentBurst({ id: "lead", role: "user" }, "agent1", true)).toEqual({ ok: true });
    expect(db.agent.update.mock.calls[0][0].data).toEqual({ burst: true, burstUntil: null });
    expect(db.agentAuditEvent.create.mock.calls[0][0].data).toMatchObject({
      action: "agent.burst_changed",
      payload: { from: false, to: true, fromUntil: null, toUntil: null, by: "admin" },
    });
  });

  it("stores an optional expiry and audits it (#596)", async () => {
    const until = new Date(Date.now() + 86_400_000);
    db.agent.findUnique.mockResolvedValue(agentRow);
    db.membership.findUnique.mockResolvedValue({ role: "admin" });
    db.agent.findUniqueOrThrow.mockResolvedValue({ burst: false, burstUntil: null });
    expect(await setAgentBurst({ id: "lead", role: "user" }, "agent1", true, until)).toEqual({ ok: true });
    expect(db.agent.update.mock.calls[0][0].data).toEqual({ burst: true, burstUntil: until });
    expect(db.agentAuditEvent.create.mock.calls[0][0].data.payload).toEqual({
      from: false,
      to: true,
      fromUntil: null,
      toUntil: until.toISOString(),
      by: "admin",
    });
  });

  it("clears the expiry when high-volume is turned off", async () => {
    const until = new Date(Date.now() + 86_400_000);
    db.agent.findUnique.mockResolvedValue(agentRow);
    db.membership.findUnique.mockResolvedValue({ role: "admin" });
    db.agent.findUniqueOrThrow.mockResolvedValue({ burst: true, burstUntil: until });
    expect(await setAgentBurst({ id: "lead", role: "user" }, "agent1", false, until)).toEqual({ ok: true });
    expect(db.agent.update.mock.calls[0][0].data).toEqual({ burst: false, burstUntil: null });
    expect(db.agentAuditEvent.create.mock.calls[0][0].data.payload).toMatchObject({
      from: true,
      to: false,
      fromUntil: until.toISOString(),
      toUntil: null,
    });
  });

  it("does not audit an unchanged grant", async () => {
    const until = new Date(Date.now() + 86_400_000);
    db.agent.findUnique.mockResolvedValue(agentRow);
    db.membership.findUnique.mockResolvedValue({ role: "admin" });
    db.agent.findUniqueOrThrow.mockResolvedValue({ burst: true, burstUntil: until });
    expect(await setAgentBurst({ id: "lead", role: "user" }, "agent1", true, until)).toEqual({ ok: true });
    expect(db.agent.update).not.toHaveBeenCalled();
    expect(db.agentAuditEvent.create).not.toHaveBeenCalled();
  });

  it("refuses an expiry that has already passed", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    db.membership.findUnique.mockResolvedValue({ role: "admin" });
    const until = new Date("2020-01-01T00:00:00.000Z");
    expect(await setAgentBurst({ id: "lead", role: "user" }, "agent1", true, until)).toMatchObject({
      ok: false,
      error: expect.stringContaining("future"),
    });
    expect(db.agent.update).not.toHaveBeenCalled();
    expect(db.agentAuditEvent.create).not.toHaveBeenCalled();
  });

  it("reports failure and keeps the audit empty when persistence fails", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    db.membership.findUnique.mockResolvedValue({ role: "admin" });
    db.agent.findUniqueOrThrow.mockResolvedValue({ burst: false, burstUntil: null });
    db.$transaction.mockRejectedValueOnce(new Error("database down"));
    expect(await setAgentBurst({ id: "lead", role: "user" }, "agent1", true)).toMatchObject({ ok: false });
    expect(db.agentAuditEvent.create).not.toHaveBeenCalled();
  });

  it("lets a site admin raise the budget", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    db.membership.findUnique.mockResolvedValue({ role: "member" });
    db.agent.findUniqueOrThrow.mockResolvedValue({ burst: false });
    expect(await setAgentBurst({ id: "ada", role: "admin" }, "agent1", true)).toEqual({ ok: true });
  });

  it("refuses an owner who is not an admin", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    db.membership.findUnique.mockResolvedValue({ role: "member" });
    expect(await setAgentBurst(ada, "agent1", true)).toMatchObject({ ok: false });
    expect(db.agent.update).not.toHaveBeenCalled();
    expect(db.agentAuditEvent.create).not.toHaveBeenCalled();
  });
});

describe("setAgentAreaPreferences (#609)", () => {
  it("saves project-owned preferences and audits the change", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    db.agentAreaPreference.findMany.mockResolvedValue([]);
    db.projectArea.findMany.mockResolvedValue([{ id: "area-web" }, { id: "area-ui" }]);
    expect(await setAgentAreaPreferences(ada, "agent1", "project_web", ["area-ui", "area-web", "area-web"])).toEqual({ ok: true });
    expect(db.agentAreaPreference.deleteMany).toHaveBeenCalledWith({ where: { agentId: "agent1", projectArea: { projectId: "project_web" } } });
    expect(db.agentAreaPreference.createMany).toHaveBeenCalledWith({ data: [
      { agentId: "agent1", projectAreaId: "area-ui" },
      { agentId: "agent1", projectAreaId: "area-web" },
    ] });
    expect(db.agentAuditEvent.create.mock.calls.at(-1)?.[0].data).toMatchObject({
      action: "agent.area_preferences_changed",
      actorUserId: "ada",
      payload: { projectId: "project_web", to: ["area-ui", "area-web"], by: "owner" },
    });
  });

  it("rejects an area from another project and unauthorized actors", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    db.projectArea.findMany.mockResolvedValue([]);
    expect(await setAgentAreaPreferences(ada, "agent1", "project_web", ["foreign-area"])).toMatchObject({ ok: false });
    expect(db.agentAreaPreference.createMany).not.toHaveBeenCalled();
    expect(await setAgentAreaPreferences({ id: "bob", role: "user" }, "agent1", "project_web", [])).toMatchObject({ ok: false });
    expect(db.agentAreaPreference.deleteMany).not.toHaveBeenCalled();
  });
});

describe("rotateKey (#427)", () => {
  const agent = {
    agentId: "agent1",
    name: "Ada's Claude",
    ownerId: "ada",
    tenantId: "tenant_zedu",
    level: "working" as const,
    burst: false,
    keyId: "key1",
  };

  it("revokes the calling key and issues a new one for the same agent", async () => {
    db.agentApiKey.updateMany.mockResolvedValue({ count: 1 });
    const key = await rotateKey(agent);
    expect(db.agentApiKey.updateMany.mock.calls[0][0].where).toEqual({ id: "key1", agentId: "agent1", revokedAt: null });
    expect(db.agentApiKey.create.mock.calls[0][0].data).toMatchObject({
      agentId: "agent1",
      keyHash: hashSecret(key.rawKey),
      prefix: key.prefix,
      projectId: null,
    });
    expect(openSecret(db.agentApiKey.create.mock.calls[0][0].data.sealedKey)).toBe(key.rawKey);
    expect(key.agentId).toBe("agent1");
  });

  it("refuses a key that was already rotated", async () => {
    db.agentApiKey.updateMany.mockResolvedValue({ count: 0 });
    await expect(rotateKey(agent)).rejects.toThrow(/already rotated/);
    expect(db.agentApiKey.create).not.toHaveBeenCalled();
  });

  it("keeps the project the calling key was limited to", async () => {
    db.agentApiKey.updateMany.mockResolvedValue({ count: 1 });
    const key = await rotateKey({ ...agent, projectId: "project_web" });
    expect(db.agentApiKey.create.mock.calls[0][0].data.projectId).toBe("project_web");
    expect(key.prefix).toBeTruthy();
  });

  it("seals the replacement for whatever project the key was limited to", async () => {
    db.agentApiKey.updateMany.mockResolvedValue({ count: 1 });
    const key = await rotateKey({ ...agent, projectId: "project_web" });
    expect(openSecret(db.agentApiKey.create.mock.calls[0][0].data.sealedKey)).toBe(key.rawKey);
    expect(db.agentApiKey.create.mock.calls[0][0].data.projectId).toBe("project_web");
  });
});

describe("regenerateKey (#572)", () => {
  const now = new Date("2026-10-20T12:00:00Z");

  it("revokes every live key and issues one for the chosen project", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    const result = await regenerateKey(ada, "agent1", "project_web", now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(db.agentApiKey.updateMany).toHaveBeenCalledWith({
      where: { agentId: "agent1", revokedAt: null },
      data: { revokedAt: now },
    });
    expect(db.agentApiKey.create.mock.calls[0][0].data).toMatchObject({
      agentId: "agent1",
      keyHash: hashSecret(result.key.rawKey),
      prefix: result.key.prefix,
      projectId: "project_web",
    });
    expect(openSecret(db.agentApiKey.create.mock.calls[0][0].data.sealedKey)).toBe(result.key.rawKey);
    expect(db.agentAuditEvent.create.mock.calls[0][0].data).toMatchObject({
      action: "agent.key_rotated",
      actorUserId: "ada",
      payload: { prefix: result.key.prefix, projectId: "project_web", by: "owner", via: "settings" },
    });
    expect(db.agent.update).not.toHaveBeenCalled();
  });

  it("refuses a revoked agent and a project outside the workspace", async () => {
    db.agent.findUnique.mockResolvedValue({ ...agentRow, revokedAt: now });
    expect(await regenerateKey(ada, "agent1", "project_web", now)).toMatchObject({ ok: false });
    db.agent.findUnique.mockResolvedValue(agentRow);
    db.project.findFirst.mockResolvedValue(null);
    expect(await regenerateKey(ada, "agent1", "project_other", now)).toMatchObject({ ok: false, field: "projectId" });
    expect(db.agentApiKey.create).not.toHaveBeenCalled();
  });

});

describe("active-agent cap (#511)", () => {
  it("refuses a sixth active agent for the same owner, with a clear error", async () => {
    db.agent.count.mockResolvedValueOnce(MAX_ACTIVE_AGENTS_PER_OWNER);
    const result = await createAgent(ada, { name: "Sixth agent", projectId: "project_web" });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("Revoke one");
    expect(db.agent.create).not.toHaveBeenCalled();
  });
});

describe("renameAgent", () => {
  it("lets the owner rename, trimmed, and logs it", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    expect(await renameAgent(ada, "agent1", "  Pixel  Two ")).toEqual({ ok: true, name: "Pixel Two" });
    expect(db.agent.update).toHaveBeenCalledWith({ where: { id: "agent1" }, data: { name: "Pixel Two" } });
    expect(db.agentAuditEvent.create.mock.calls[0][0].data).toMatchObject({
      action: "agent.renamed",
      payload: { from: agentRow.name, to: "Pixel Two", by: "owner" },
    });
  });

  it("refuses a name the owner already uses for another agent", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    db.agent.findFirst.mockResolvedValueOnce({ id: "agent2" });
    expect(await renameAgent(ada, "agent1", "Scout")).toMatchObject({ ok: false });
    expect(db.agent.update).not.toHaveBeenCalled();
  });

  it("refuses a too-short name, a revoked agent and anyone else", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    expect(await renameAgent(ada, "agent1", "x")).toMatchObject({ ok: false });
    expect(await renameAgent({ id: "bob", role: "user" }, "agent1", "Scout")).toMatchObject({ ok: false });
    db.agent.findUnique.mockResolvedValue({ ...agentRow, revokedAt: new Date() });
    expect(await renameAgent(ada, "agent1", "Scout")).toMatchObject({ ok: false });
    expect(db.agent.update).not.toHaveBeenCalled();
  });
});

describe("setAgentAvatar", () => {
  it("lets the owner pick a robot, and logs it", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    db.agent.findUniqueOrThrow.mockResolvedValue({ avatar: null });
    expect(await setAgentAvatar(ada, "agent1", "grape")).toEqual({ ok: true });
    expect(db.agent.update).toHaveBeenCalledWith({ where: { id: "agent1" }, data: { avatar: "grape" } });
    expect(db.agentAuditEvent.create.mock.calls[0][0].data).toMatchObject({
      action: "agent.avatar_changed",
      payload: { from: null, to: "grape", by: "owner" },
    });
  });

  it("goes back to the automatic robot with null", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    db.agent.findUniqueOrThrow.mockResolvedValue({ avatar: "grape" });
    expect(await setAgentAvatar(ada, "agent1", null)).toEqual({ ok: true });
    expect(db.agent.update).toHaveBeenCalledWith({ where: { id: "agent1" }, data: { avatar: null } });
  });

  it("refuses an unknown avatar, a revoked agent and anyone else", async () => {
    db.agent.findUnique.mockResolvedValue(agentRow);
    expect(await setAgentAvatar(ada, "agent1", "not-a-robot")).toMatchObject({ ok: false });
    expect(await setAgentAvatar({ id: "bob", role: "user" }, "agent1", "sky")).toMatchObject({ ok: false });
    db.agent.findUnique.mockResolvedValue({ ...agentRow, revokedAt: new Date() });
    expect(await setAgentAvatar(ada, "agent1", "sky")).toMatchObject({ ok: false });
    expect(db.agent.update).not.toHaveBeenCalled();
  });
});
