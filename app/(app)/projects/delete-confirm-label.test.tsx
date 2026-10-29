import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const requireUser = vi.hoisted(() => vi.fn());
const currentTenantIdFor = vi.hoisted(() => vi.fn());
const isTenantAdmin = vi.hoisted(() => vi.fn());
const isTenantAdminRole = vi.hoisted(() => vi.fn());
const isSuperAdmin = vi.hoisted(() => vi.fn());
const activeProjectIdFor = vi.hoisted(() => vi.fn());
const getPlatformRewardConfig = vi.hoisted(() => vi.fn());
const findTenant = vi.hoisted(() => vi.fn());
const findProjects = vi.hoisted(() => vi.fn());
const findMembership = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth-helpers", () => ({ requireUser }));
vi.mock("@/lib/tenant-context", () => ({ currentTenantIdFor, NO_TENANT_MESSAGE: "no tenant" }));
vi.mock("@/lib/project-context", () => ({ activeProjectIdFor }));
vi.mock("@/lib/agents/membership", () => ({ isTenantAdmin, isTenantAdminRole }));
vi.mock("@/lib/roles", () => ({ isSuperAdmin }));
vi.mock("@/lib/points/platform-rewards", () => ({
  getPlatformRewardConfig,
  projectDefaultsFromPlatform: () => ({}),
}));
vi.mock("@/lib/points/project-rewards", () => ({ parseProjectRewardConfig: () => ({}) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: findTenant },
    project: { findMany: findProjects },
    membership: { findUnique: findMembership },
  },
}));
vi.mock("./actions", () => ({
  deleteProjectAction: vi.fn(),
  setProjectArchivedAction: vi.fn(),
  switchProjectAction: vi.fn(),
}));
vi.mock("./copy-project-id", () => ({ CopyProjectIdButton: () => null }));
vi.mock("./create-project-form", () => ({ CreateProjectForm: () => null }));
vi.mock("./mission-coverage", () => ({ MissionCoverage: () => null }));
vi.mock("@/components/project-reward-rules-display", () => ({
  ProjectRewardRulesDisplay: () => null,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import ProjectsPage from "./page";

const project = (over: Record<string, unknown>) => ({
  id: "p1",
  name: "Web",
  slug: "web",
  archivedAt: null,
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  rewardConfig: null,
  _count: { bugs: 0 },
  testMissions: [],
  ...over,
});

async function render() {
  return renderToStaticMarkup(
    await ProjectsPage({ searchParams: Promise.resolve({}) }),
  ).replace(/<!-- -->/g, "");
}

/**
 * #561: the project-delete confirmation inputs had only a placeholder, which
 * disappears as soon as someone types, and the archived list repeated several
 * identical unlabeled inputs beside buttons that just said "Delete".
 */
describe("project delete confirmation labels (#561)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "user-1", role: "admin" });
    currentTenantIdFor.mockResolvedValue("tenant-1");
    isTenantAdmin.mockResolvedValue(true);
    isTenantAdminRole.mockReturnValue(true);
    isSuperAdmin.mockReturnValue(true);
    activeProjectIdFor.mockResolvedValue("p1");
    getPlatformRewardConfig.mockResolvedValue({});
    findTenant.mockResolvedValue({ name: "Acme" });
    findMembership.mockResolvedValue({ role: "owner" });
    findProjects.mockResolvedValue([
      project({}),
      project({ id: "p2", name: "Legacy", slug: "legacy", archivedAt: new Date("2026-10-02T00:00:00.000Z") }),
    ]);
  });

  it("ties a visible label to the active project's confirm input", async () => {
    const html = await render();
    expect(html).toContain('for="confirm-delete-p1"');
    expect(html).toContain('id="confirm-delete-p1"');
    expect(html).toContain("Type Web to confirm deleting it");
  });

  it("gives each archived project's confirm input an accessible name", async () => {
    const html = await render();
    expect(html).toContain('aria-label="Type Legacy to confirm deleting it"');
  });

  it("names the project on the archived delete button", async () => {
    const html = await render();
    expect(html).toContain("Delete Legacy");
  });

  it("no longer relies on the placeholder alone for an accessible name", async () => {
    const html = await render();
    // Every confirmName input must carry an id (labelled) or an aria-label.
    const inputs = html.match(/<input[^>]*name="confirmName"[^>]*>/g) ?? [];
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(/id="confirm-delete|aria-label="/.test(input)).toBe(true);
    }
  });
});
