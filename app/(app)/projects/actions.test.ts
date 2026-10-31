import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.hoisted(() => vi.fn());
const currentTenantIdFor = vi.hoisted(() => vi.fn());
const cookieGet = vi.hoisted(() => vi.fn());
const cookieSet = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const isTenantAdmin = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: cookieGet, set: cookieSet }),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser }));
vi.mock("@/lib/agents/membership", () => ({ isTenantAdmin }));
vi.mock("@/lib/tenant-context", () => ({
  currentTenantIdFor,
  NO_TENANT_MESSAGE: "You're not a member of a workspace yet.",
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: {
      findMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    membership: {
      findUnique: vi.fn(),
    },
    testMission: { createMany: vi.fn() },
    $transaction: vi.fn(),
    projectAuditEvent: { create: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import { ACTIVE_PROJECT_COOKIE } from "@/lib/project-context";
import {
  createProjectAction,
  createTestMissionAction,
  deleteProjectAction,
  setProjectArchivedAction,
  switchProjectAction,
  updateProjectAction,
} from "./actions";

const findMany = vi.mocked(prisma.project.findMany) as unknown as ReturnType<typeof vi.fn>;
const create = vi.mocked(prisma.project.create) as unknown as ReturnType<typeof vi.fn>;
const findFirst = vi.mocked(prisma.project.findFirst) as unknown as ReturnType<typeof vi.fn>;
const update = vi.mocked(prisma.project.update) as unknown as ReturnType<typeof vi.fn>;
const remove = vi.mocked(prisma.project.delete) as unknown as ReturnType<typeof vi.fn>;
const membership = vi.mocked(prisma.membership.findUnique) as unknown as ReturnType<typeof vi.fn>;
const createManyMissions = vi.mocked(prisma.testMission.createMany) as unknown as ReturnType<typeof vi.fn>;

const REDIRECT = new Error("NEXT_REDIRECT");
redirect.mockImplementation(() => {
  throw REDIRECT;
});

function form(values: Record<string, string | string[]>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    for (const entry of Array.isArray(value) ? value : [value]) data.append(key, entry);
  }
  return data;
}

async function expectRedirect(promise: Promise<unknown>) {
  await expect(promise).rejects.toBe(REDIRECT);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: "user-1", role: "user" });
  currentTenantIdFor.mockResolvedValue("tenant-zedu");
  findMany.mockResolvedValue([{ slug: "zedu" }]);
  create.mockResolvedValue({ id: "project-new" });
  findFirst.mockResolvedValue({ id: "project-zedu" });
  update.mockResolvedValue({});
  remove.mockResolvedValue({});
  membership.mockResolvedValue({ role: "owner" });
  isTenantAdmin.mockResolvedValue(true);
  createManyMissions.mockResolvedValue({ count: 4 });
  cookieGet.mockReturnValue(undefined);
});

describe("createProjectAction (#426)", () => {
  it("creates a project in the current tenant and makes it active", async () => {
    await expectRedirect(
      createProjectAction(undefined, form({ name: "  Zedu Web  " })),
    );

    expect(create).toHaveBeenCalledWith({
      data: { tenantId: "tenant-zedu", name: "Zedu Web", slug: "zedu-web", workflow: { create: {} } },
      select: { id: true },
    });
    expect(cookieSet).toHaveBeenCalledWith(
      ACTIVE_PROJECT_COOKIE,
      "project-new",
      expect.objectContaining({ path: "/", httpOnly: true }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(redirect).toHaveBeenCalledWith("/issues");
  });

  it("adds a suffix instead of failing on a duplicate slug", async () => {
    findMany.mockResolvedValue([{ slug: "zedu-web" }]);

    await expectRedirect(createProjectAction(undefined, form({ name: "Zedu Web" })));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: "zedu-web-2" }),
      }),
    );
  });

  it("rejects a blank name without writing", async () => {
    const result = await createProjectAction(undefined, form({ name: "   " }));

    expect(result.error).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("does nothing for someone without a workspace", async () => {
    currentTenantIdFor.mockResolvedValue(null);

    const result = await createProjectAction(undefined, form({ name: "Zedu Web" }));

    expect(result.error).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("switchProjectAction (#426)", () => {
  it("stores the project and returns to the scoped issue list", async () => {
    await expectRedirect(switchProjectAction(form({ projectId: "project-zedu" })));

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "project-zedu", tenantId: "tenant-zedu", archivedAt: null },
      select: { id: true },
    });
    expect(cookieSet).toHaveBeenCalledWith(
      ACTIVE_PROJECT_COOKIE,
      "project-zedu",
      expect.objectContaining({ path: "/", httpOnly: true }),
    );
    expect(redirect).toHaveBeenCalledWith("/issues");
  });

  it("ignores another tenant's project without setting the cookie", async () => {
    findFirst.mockResolvedValue(null);

    await switchProjectAction(form({ projectId: "project-other" }));

    expect(cookieSet).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("requires a project id", async () => {
    await switchProjectAction(form({}));

    expect(findFirst).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });
});

describe("project lifecycle actions (#573)", () => {
  const project = {
    id: "project-zedu",
    name: "Zedu",
    archivedAt: null,
    _count: { bugs: 0 },
  };

  beforeEach(() => {
    findFirst.mockResolvedValue(project);
  });

  it("doesn't archive or delete for a member", async () => {
    membership.mockResolvedValue({ role: "member" });
    await expectRedirect(
      setProjectArchivedAction(form({ projectId: project.id, archived: "true" })),
    );
    expect(update).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(expect.stringContaining("/org/projects?error="));
  });

  it("allows archiving and deleting for a super_admin even if membership is member", async () => {
    requireUser.mockResolvedValue({ id: "user-super", role: "super_admin" });
    membership.mockResolvedValue({ role: "member" });

    await expectRedirect(
      setProjectArchivedAction(form({ projectId: project.id, archived: "true" })),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: project.id },
      data: { archivedAt: expect.any(Date) },
    });
    expect(redirect).toHaveBeenCalledWith("/org/projects?notice=Project%20archived.");

    await expectRedirect(
      deleteProjectAction(form({ projectId: project.id, confirmName: project.name })),
    );
    expect(remove).toHaveBeenCalledWith({ where: { id: project.id } });
    expect(redirect).toHaveBeenCalledWith("/org/projects?notice=Project%20deleted.");
  });

  it("archives and restores a project", async () => {
    await expectRedirect(
      setProjectArchivedAction(form({ projectId: project.id, archived: "true" })),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: project.id },
      data: { archivedAt: expect.any(Date) },
    });
    expect(redirect).toHaveBeenCalledWith("/org/projects?notice=Project%20archived.");

    findFirst.mockResolvedValue({ ...project, archivedAt: new Date("2026-10-01") });
    await expectRedirect(
      setProjectArchivedAction(form({ projectId: project.id, archived: "false" })),
    );
    expect(update).toHaveBeenLastCalledWith({
      where: { id: project.id },
      data: { archivedAt: null },
    });
  });

  it("deletes an empty project after the typed name", async () => {
    await expectRedirect(
      deleteProjectAction(form({ projectId: project.id, confirmName: project.name })),
    );

    expect(remove).toHaveBeenCalledWith({ where: { id: project.id } });
    expect(redirect).toHaveBeenCalledWith("/org/projects?notice=Project%20deleted.");
  });

  it("refuses to delete a project with issues, or with the wrong name", async () => {
    findFirst.mockResolvedValue({ ...project, _count: { bugs: 2 } });
    await expectRedirect(
      deleteProjectAction(form({ projectId: project.id, confirmName: project.name })),
    );
    expect(remove).not.toHaveBeenCalled();

    findFirst.mockResolvedValue(project);
    await expectRedirect(
      deleteProjectAction(form({ projectId: project.id, confirmName: "wrong" })),
    );
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("createTestMissionAction (#619)", () => {
  it("creates route missions for selected roles and viewports in the current tenant", async () => {
    const result = await createTestMissionAction(undefined, form({
      projectId: "project-zedu",
      routePattern: "/settings/**",
      brief: "Check settings behavior",
      roles: ["admin", "member"],
      viewports: ["desktop", "mobile_375"],
    }));

    expect(result).toEqual({ message: "Added 4 test missions." });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "project-zedu", tenantId: "tenant-zedu" },
      select: { id: true },
    });
    expect(isTenantAdmin).toHaveBeenCalledWith({ id: "user-1", role: "user" }, "tenant-zedu");
    expect(createManyMissions).toHaveBeenCalledWith({
      data: [
        { projectId: "project-zedu", routePattern: "/settings/**", brief: "Check settings behavior", role: "admin", viewport: "desktop" },
        { projectId: "project-zedu", routePattern: "/settings/**", brief: "Check settings behavior", role: "admin", viewport: "mobile_375" },
        { projectId: "project-zedu", routePattern: "/settings/**", brief: "Check settings behavior", role: "member", viewport: "desktop" },
        { projectId: "project-zedu", routePattern: "/settings/**", brief: "Check settings behavior", role: "member", viewport: "mobile_375" },
      ],
      skipDuplicates: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/org/projects");
  });

  it("does not allow a workspace member to manage missions", async () => {
    isTenantAdmin.mockResolvedValue(false);

    const result = await createTestMissionAction(undefined, form({
      projectId: "project-zedu", routePattern: "/settings", brief: "Check settings",
      roles: ["member"], viewports: ["desktop"],
    }));

    expect(result.error).toBeTruthy();
    expect(createManyMissions).not.toHaveBeenCalled();
  });

  it("rejects invalid route patterns before writing", async () => {
    const result = await createTestMissionAction(undefined, form({
      projectId: "project-zedu", routePattern: "https://other.example", brief: "Check settings",
      roles: ["member"], viewports: ["desktop"],
    }));

    expect(result.error).toBeTruthy();
    expect(createManyMissions).not.toHaveBeenCalled();
  });
});

describe("updateProjectAction (#608)", () => {
  it("updates settings and records the change with the actor", async () => {
    findFirst.mockResolvedValue({ id: "project-zedu", name: "Web", goal: null, repoUrl: null, stagingUrl: null });
    const update = vi.fn();
    const audit = vi.fn();
    const transaction = vi.mocked(prisma.$transaction) as unknown as ReturnType<typeof vi.fn>;
    transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) =>
      work({ project: { update }, projectAuditEvent: { create: audit } }),
    );
    const result = await updateProjectAction(undefined, form({ slug: "web", name: "Web App", goal: "Ship", repoUrl: "https://github.com/acme/web", stagingUrl: "https://staging.example.com" }));
    expect(result).toEqual({});
    expect(update).toHaveBeenCalledWith({ where: { id: "project-zedu" }, data: { name: "Web App", goal: "Ship", repoUrl: "https://github.com/acme/web", stagingUrl: "https://staging.example.com" } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ tenantId: "tenant-zedu", projectId: "project-zedu", actorUserId: "user-1", action: "settings.updated" }) }));
    expect(revalidatePath).toHaveBeenCalledWith("/projects/web/settings");
    expect(revalidatePath).toHaveBeenCalledWith("/issues");
  });

  it("refuses members and invalid URLs without writing", async () => {
    isTenantAdmin.mockResolvedValue(false);
    expect(await updateProjectAction(undefined, form({ slug: "web", name: "Web", goal: "", repoUrl: "https://evil.example/repo", stagingUrl: "http://staging.example.com" }))).toMatchObject({ error: expect.any(String) });
    expect(findFirst).not.toHaveBeenCalled();
    isTenantAdmin.mockResolvedValue(true);
    const invalid = await updateProjectAction(undefined, form({ slug: "web", name: "Web", goal: "", repoUrl: "https://evil.example/repo", stagingUrl: "http://staging.example.com" }));
    expect(invalid.fieldErrors).toMatchObject({ repoUrl: expect.any(String), stagingUrl: expect.any(String) });
    expect(vi.mocked(prisma.$transaction)).not.toHaveBeenCalled();
  });
});
