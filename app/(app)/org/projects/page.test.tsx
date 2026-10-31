import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const loadOrg = vi.hoisted(() => vi.fn());
const activeProjectIdFor = vi.hoisted(() => vi.fn());
const getPlatformRewardConfig = vi.hoisted(() => vi.fn());
const findProjects = vi.hoisted(() => vi.fn());

vi.mock("../org-context", () => ({ loadOrg }));
vi.mock("@/lib/project-context", () => ({ activeProjectIdFor }));
vi.mock("@/lib/points/platform-rewards", () => ({
  getPlatformRewardConfig,
  projectDefaultsFromPlatform: () => ({}),
}));
vi.mock("@/lib/points/project-rewards", () => ({ parseProjectRewardConfig: () => ({}) }));
vi.mock("@/lib/prisma", () => ({
  prisma: { project: { findMany: findProjects } },
}));
vi.mock("@/app/(app)/projects/actions", () => ({
  deleteProjectAction: vi.fn(),
  setProjectArchivedAction: vi.fn(),
  switchProjectAction: vi.fn(),
}));
vi.mock("@/app/(app)/projects/copy-project-id", () => ({ CopyProjectIdButton: () => null }));
vi.mock("@/app/(app)/projects/create-project-form", () => ({ CreateProjectForm: () => null }));
vi.mock("@/app/(app)/projects/mission-coverage", () => ({ MissionCoverage: () => null }));
vi.mock("@/components/confirm-submit-button", () => ({
  ConfirmSubmitButton: ({ children }: { children: React.ReactNode }) => <button type="submit">{children}</button>,
}));
vi.mock("@/components/project-reward-rules-display", () => ({
  ProjectRewardRulesDisplay: () => null,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import ProjectsPage from "./page";

const ORG = { id: "tenant-1", name: "Acme", slug: "acme", role: "owner", admin: true, owner: true };

const project = (over: Record<string, unknown>) => ({
  id: "p1",
  name: "Web",
  slug: "web",
  archivedAt: null,
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  rewardConfig: null,
  githubInstallationId: null,
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
    loadOrg.mockResolvedValue({ user: { id: "user-1", role: "user" }, org: ORG });
    activeProjectIdFor.mockResolvedValue("p1");
    getPlatformRewardConfig.mockResolvedValue({});
    findProjects.mockResolvedValue([
      project({}),
      project({ id: "p2", name: "Legacy", slug: "legacy", archivedAt: new Date("2026-10-02T00:00:00.000Z") }),
    ]);
  });

  it("ties a visible label to the active project's confirm input", async () => {
    const html = await render();
    expect(html).toContain('for="confirm-delete-p1"');
    expect(html).toContain('id="confirm-delete-p1"');
  });

  it("gives each archived project's confirm input an accessible name that names the project", async () => {
    const html = await render();
    expect(html).toMatch(/<input[^>]*aria-label="[^"]*Legacy[^"]*"[^>]*>/);
  });

  it("names the project on the archived delete button", async () => {
    const html = await render();
    expect(html).toMatch(/Delete Legacy/i);
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

/** The organization's projects list (moved here from the Settings "Projects" section). */
describe("organization projects list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeProjectIdFor.mockResolvedValue("p1");
    getPlatformRewardConfig.mockResolvedValue({});
    findProjects.mockResolvedValue([
      project({ githubInstallationId: "12345", _count: { bugs: 12 } }),
      project({ id: "p2", name: "Mobile", slug: "mobile", _count: { bugs: 1 } }),
    ]);
  });

  it("lists only this organization's projects", async () => {
    loadOrg.mockResolvedValue({ user: { id: "user-1", role: "user" }, org: ORG });
    await render();
    expect(findProjects).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-1" } }));
  });

  it("links owners and admins to each project's settings, GitHub App and issues", async () => {
    loadOrg.mockResolvedValue({
      user: { id: "user-1", role: "user" },
      org: { ...ORG, role: "admin", owner: false },
    });
    const html = await render();
    for (const slug of ["web", "mobile"]) {
      expect(html).toContain(`href="/projects/${slug}/settings"`);
      expect(html).toContain(`href="/projects/${slug}/settings/github"`);
      expect(html).toContain(`href="/issues?project=${slug}"`);
    }
    expect(html).toContain("GitHub App connected");
    expect(html).toContain("GitHub App not connected");
    expect(html).toContain("12 issues");
    expect(html).toContain("1 issue");
    // Archiving and deleting stay with owners.
    expect(html).not.toContain("Archive or delete");
  });

  it("shows members the list and issue links, without settings links", async () => {
    loadOrg.mockResolvedValue({
      user: { id: "user-1", role: "user" },
      org: { ...ORG, role: "member", admin: false, owner: false },
    });
    const html = await render();
    expect(html).toContain('href="/issues?project=web"');
    expect(html).not.toContain('href="/projects/web/settings"');
    expect(html).not.toContain('href="/projects/web/settings/github"');
  });

  it("renders nothing for someone with no organization", async () => {
    loadOrg.mockResolvedValue({ user: { id: "user-1", role: "user" }, org: null });
    expect(await ProjectsPage({ searchParams: Promise.resolve({}) })).toBeNull();
    expect(findProjects).not.toHaveBeenCalled();
  });
});
