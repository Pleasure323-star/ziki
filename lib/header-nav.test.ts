import { describe, expect, it } from "vitest";
import {
  SWITCH_TENANT_LINK,
  headerNavItems,
  initialsOf,
  isNavItemActive,
  realRoleOf,
} from "./header-nav";

describe("SWITCH_TENANT_LINK (#444)", () => {
  it("goes to the tenant picker, and is marked current on it and its pages", () => {
    expect(SWITCH_TENANT_LINK).toEqual({ href: "/tenants", label: "Switch workspace" });
    expect(isNavItemActive("/tenants", SWITCH_TENANT_LINK.href)).toBe(true);
    expect(isNavItemActive("/tenants/acme", SWITCH_TENANT_LINK.href)).toBe(true);
    expect(isNavItemActive("/issues", SWITCH_TENANT_LINK.href)).toBe(false);
  });

  it("stays out of the main nav, which is unchanged", () => {
    for (const role of ["user", "admin", "super_admin"] as const) {
      expect(headerNavItems(role).map((i) => i.href)).not.toContain("/tenants");
    }
  });
});

describe("headerNavItems (#761)", () => {
  it("shows Dashboard, Issues and Escalations to normal users; Team moved to Settings (#423)", () => {
    const items = headerNavItems("user");
    expect(items.map((i) => i.label)).toEqual(["Dashboard", "Issues", "Escalations"]);
    expect(items.map((i) => i.href)).not.toContain("/team");
    expect(items.map((i) => i.label)).not.toContain("Workspace");
    expect(items.find((i) => i.label === "Escalations")?.children).toBeUndefined();
  });

  it("shows API Docs on the bar when the agent platform is explicitly disabled", () => {
    expect(headerNavItems("user", { agentPlatform: false }).map((i) => i.label)).toEqual([
      "Dashboard",
      "Issues",
      "API Docs",
    ]);
  });

  it("links Escalations directly when the agent platform is enabled (#627)", () => {
    const items = headerNavItems("user", { agentPlatform: true });
    expect(items.map((i) => i.label)).toEqual(["Dashboard", "Issues", "Escalations"]);
    const item = items.find((i) => i.label === "Escalations");
    expect(item?.href).toBe("/escalations");
    expect(item?.children).toBeUndefined();
  });

  it("includes pending escalations badge count when provided (#763)", () => {
    const item = headerNavItems("user", { agentPlatform: true, pendingEscalations: 3 }).find(
      (i) => i.label === "Escalations",
    );
    expect(item?.badge).toBe(3);

    const quiet = headerNavItems("user", { agentPlatform: true, pendingEscalations: 0 }).find(
      (i) => i.label === "Escalations",
    );
    expect(quiet?.badge).toBeUndefined();
  });

  it("adds Admins for super admins (#761)", () => {
    expect(headerNavItems("super_admin").map((i) => i.label)).toEqual([
      "Dashboard",
      "Issues",
      "Escalations",
      "Admins",
    ]);
  });
});

describe("isNavItemActive", () => {
  it("marks Issues active on the list and on an issue, not on the new-issue form", () => {
    expect(isNavItemActive("/issues", "/issues")).toBe(true);
    expect(isNavItemActive("/notes", "/issues")).toBe(true);
    expect(isNavItemActive("/notes", "/marketing")).toBe(false);
    expect(isNavItemActive("/issues/", "/issues")).toBe(true);
    expect(isNavItemActive("/issues/abc123", "/issues")).toBe(true);
    expect(isNavItemActive("/issues/new", "/issues")).toBe(false);
    expect(isNavItemActive("/bugs", "/issues")).toBe(true);
    expect(isNavItemActive("/bugs/abc123", "/issues")).toBe(true);
  });

  it("keeps Product active on an idea, which opens from the Inbox (#idea-table)", () => {
    expect(isNavItemActive("/ideas/12", "/issues")).toBe(true);
    expect(isNavItemActive("/ideas/12", "/marketing")).toBe(false);
  });

  it("matches admin pages by prefix only on a path boundary", () => {
    expect(isNavItemActive("/admin/types", "/admin/types")).toBe(true);
    expect(isNavItemActive("/admin/types/x", "/admin/types")).toBe(true);
    expect(isNavItemActive("/admin/typesx", "/admin/types")).toBe(false);
    expect(isNavItemActive("/settings", "/admin/types")).toBe(false);
    expect(isNavItemActive(null, "/issues")).toBe(false);
  });

  it("marks Escalations active for /escalations and legacy /questions (#763)", () => {
    expect(isNavItemActive("/escalations", "/escalations")).toBe(true);
    expect(isNavItemActive("/escalations/q1", "/escalations")).toBe(true);
    expect(isNavItemActive("/questions", "/escalations")).toBe(true);
    expect(isNavItemActive("/questions/q1", "/escalations")).toBe(true);
    expect(isNavItemActive("/redesigns", "/escalations")).toBe(true);
    expect(isNavItemActive("/redesigns/r1", "/escalations")).toBe(true);
    expect(isNavItemActive("/issues", "/escalations")).toBe(false);
  });

  it("marks Manage Workspace active on grouped sub-routes (#761)", () => {
    expect(isNavItemActive("/projects", "/manage-project")).toBe(true);
    expect(isNavItemActive("/projects/p1", "/manage-project")).toBe(true);
    expect(isNavItemActive("/milestones", "/manage-project")).toBe(true);
    expect(isNavItemActive("/milestones/m1", "/manage-project")).toBe(true);
    expect(isNavItemActive("/admin/categories", "/manage-project")).toBe(true);
    expect(isNavItemActive("/admin/types", "/manage-project")).toBe(true);
    expect(isNavItemActive("/issues", "/manage-project")).toBe(false);
    expect(isNavItemActive("/escalations", "/manage-project")).toBe(false);
  });
});

describe("realRoleOf", () => {
  it("ignores the View as override", () => {
    expect(realRoleOf({ isRealSuperAdmin: true, isRealAdmin: true })).toBe("super_admin");
    expect(realRoleOf({ isRealAdmin: true })).toBe("admin");
    expect(realRoleOf({})).toBe("user");
  });
});

describe("initialsOf", () => {
  it("builds up to two initials", () => {
    expect(initialsOf("Bob Builder")).toBe("BB");
    expect(initialsOf("Alice Mentor Smith")).toBe("AS");
    expect(initialsOf("cara")).toBe("CA");
    expect(initialsOf("jane.doe@zedu.chat")).toBe("JD");
    expect(initialsOf("")).toBe("?");
    expect(initialsOf(null)).toBe("?");
  });
});


describe("Profile and Settings active state (#576)", () => {
  it.each(["/settings/profile", "/settings/profile/", "/settings/profile/details"])(
    "marks Profile exclusively on %s", (pathname) => {
      expect(isNavItemActive(pathname, "/settings/profile")).toBe(true);
      expect(isNavItemActive(pathname, "/settings")).toBe(false);
    },
  );

  it.each(["/settings", "/settings/", "/settings/security", "/settings/profiles"])(
    "keeps Settings active outside the Profile path boundary on %s", (pathname) => {
      expect(isNavItemActive(pathname, "/settings")).toBe(true);
      expect(isNavItemActive(pathname, "/settings/profile")).toBe(false);
    },
  );
});
