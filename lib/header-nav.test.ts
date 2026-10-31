import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_HREF,
  SITE_ADMIN_HREF,
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
    expect(isNavItemActive("/tenants/invite/abc", SWITCH_TENANT_LINK.href)).toBe(true);
    expect(isNavItemActive("/issues", SWITCH_TENANT_LINK.href)).toBe(false);
  });

  it("stays out of the main nav, which is unchanged", () => {
    for (const role of ["user", "admin", "super_admin"] as const) {
      expect(headerNavItems(role).map((i) => i.href)).not.toContain("/tenants");
    }
  });
});

describe("headerNavItems (#761)", () => {
  it("shows Dashboard, Issues and Inbox to normal users; Team moved to Settings (#423)", () => {
    const items = headerNavItems("user");
    expect(items.map((i) => i.label)).toEqual(["Dashboard", "Issues", "Inbox"]);
    expect(items.map((i) => i.href)).not.toContain("/team");
    expect(items.map((i) => i.label)).not.toContain("Workspace");
    expect(items.find((i) => i.label === "Inbox")?.children).toBeUndefined();
  });

  it("shows API Docs on the bar when the agent platform is explicitly disabled", () => {
    expect(headerNavItems("user", { agentPlatform: false }).map((i) => i.label)).toEqual([
      "Dashboard",
      "Issues",
      "API Docs",
    ]);
  });

  it("links Inbox directly when the agent platform is enabled (#627)", () => {
    const items = headerNavItems("user", { agentPlatform: true });
    expect(items.map((i) => i.label)).toEqual(["Dashboard", "Issues", "Inbox"]);
    const item = items.find((i) => i.label === "Inbox");
    expect(item?.href).toBe("/inbox");
    expect(item?.children).toBeUndefined();
  });

  it("includes pending escalations badge count when provided (#763)", () => {
    const item = headerNavItems("user", { agentPlatform: true, pendingEscalations: 3 }).find(
      (i) => i.label === "Inbox",
    );
    expect(item?.badge).toBe(3);

    const quiet = headerNavItems("user", { agentPlatform: true, pendingEscalations: 0 }).find(
      (i) => i.label === "Inbox",
    );
    expect(quiet?.badge).toBeUndefined();
  });

  it("adds Site admin for super admins (#761)", () => {
    const items = headerNavItems("super_admin");
    expect(items.map((i) => i.label)).toEqual([
      "Dashboard",
      "Issues",
      "Inbox",
      "Site admin",
    ]);
    expect(items.find((i) => i.label === "Site admin")?.href).toBe(SITE_ADMIN_HREF);
    expect(SITE_ADMIN_HREF).toBe("/admin/users");
  });

  it("keeps Site admin away from admins and normal users", () => {
    for (const role of ["user", "admin"] as const) {
      expect(headerNavItems(role).map((i) => i.href)).not.toContain(SITE_ADMIN_HREF);
    }
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

  it("keeps Product active on an idea, which opens from the Ideas tab (#idea-table)", () => {
    expect(isNavItemActive("/ideas/12", "/issues")).toBe(true);
    expect(isNavItemActive("/ideas/12", "/marketing")).toBe(false);
  });

  it("matches admin pages by prefix only on a path boundary", () => {
    expect(isNavItemActive("/org/types", "/org/types")).toBe(true);
    expect(isNavItemActive("/org/types/x", "/org/types")).toBe(true);
    expect(isNavItemActive("/org/typesx", "/org/types")).toBe(false);
    expect(isNavItemActive("/settings", "/org/types")).toBe(false);
    expect(isNavItemActive(null, "/issues")).toBe(false);
  });

  it("marks Inbox active on its tabs, an escalation, and legacy /questions and /redesigns (#inbox)", () => {
    expect(isNavItemActive("/inbox", "/inbox")).toBe(true);
    expect(isNavItemActive("/inbox/escalations/q1", "/inbox")).toBe(true);
    expect(isNavItemActive("/questions", "/inbox")).toBe(true);
    expect(isNavItemActive("/questions/q1", "/inbox")).toBe(true);
    expect(isNavItemActive("/redesigns", "/inbox")).toBe(true);
    expect(isNavItemActive("/redesigns/r1", "/inbox")).toBe(true);
    expect(isNavItemActive("/issues", "/inbox")).toBe(false);
  });

  it("marks Organization active on every /org tab", () => {
    expect(ORGANIZATION_HREF).toBe("/org");
    expect(isNavItemActive("/org", ORGANIZATION_HREF)).toBe(true);
    expect(isNavItemActive("/org/members", ORGANIZATION_HREF)).toBe(true);
    expect(isNavItemActive("/org/projects", ORGANIZATION_HREF)).toBe(true);
    expect(isNavItemActive("/org/milestones", ORGANIZATION_HREF)).toBe(true);
    expect(isNavItemActive("/organic", ORGANIZATION_HREF)).toBe(false);
    expect(isNavItemActive("/issues", ORGANIZATION_HREF)).toBe(false);
  });

  it("marks Site admin active on every /admin page, not only the users list", () => {
    expect(isNavItemActive("/admin", SITE_ADMIN_HREF)).toBe(true);
    expect(isNavItemActive("/admin/users", SITE_ADMIN_HREF)).toBe(true);
    expect(isNavItemActive("/admin/rewards", SITE_ADMIN_HREF)).toBe(true);
    expect(isNavItemActive("/administer", SITE_ADMIN_HREF)).toBe(false);
    expect(isNavItemActive("/org", SITE_ADMIN_HREF)).toBe(false);
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
