import { isSuperAdmin, type AppRole } from "@/lib/roles";
import { isAgentPlatformEnabled } from "@/lib/feature-flags";
import { isProjectIssuePath } from "@/lib/project-slug";

export type HeaderNavSubItem = {
  href: string;
  label: string;
  description?: string;
  badge?: number;
};

export type HeaderNavItem = {
  href: string;
  label: string;
  badge?: number;
  children?: HeaderNavSubItem[];
};

/** #444: pick another tenant, create one, or accept an invite. */
export const SWITCH_TENANT_LINK: HeaderNavItem = { href: "/tenants", label: "Switch workspace" };

/** Site staff pages: site roles and platform points. Super admins only. */
export const SITE_ADMIN_HREF = "/admin/users";

/** The current organization's admin area: members, invites, projects, taxonomy, settings. */
export const ORGANIZATION_HREF = "/org";

/** Manage agents: the person's own agents, on a page of its own outside Settings. */
export const MANAGE_AGENTS_HREF = "/agents";

/** One agent's own page, addressed by its name. Agents in the Agents menu open here. */
export function agentPageHref(agentName: string): string {
  return `/settings/agent/${encodeURIComponent(agentName)}`;
}

/** Links shown in the header for the role the user is currently viewing as (#761). */
export function headerNavItems(
  role?: AppRole | null,
  options?: { agentPlatform?: boolean; pendingEscalations?: number },
): HeaderNavItem[] {
  const pending =
    typeof options?.pendingEscalations === "number" && options.pendingEscalations > 0
      ? options.pendingEscalations
      : undefined;

  const items: HeaderNavItem[] = [
    // Post-login landing: the workspace overview.
    { href: "/dashboard", label: "Dashboard" },
    { href: "/issues", label: "Issues" },
  ];

  if (options?.agentPlatform ?? isAgentPlatformEnabled()) {
    items.push({
      href: "/inbox",
      label: "Inbox",
      ...(pending ? { badge: pending } : {}),
    });
  } else {
    items.push({ href: "/docs", label: "API Docs" });
  }

  if (isSuperAdmin(role)) {
    items.push({ href: SITE_ADMIN_HREF, label: "Site admin" });
  }

  return items;
}

/**
 * Whether a header link is the current page. "Issues" covers the list and
 * individual issues, but not the "New issue" form, which has its own button.
 */
export function isNavItemActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  const path = pathname.replace(/\/+$/, "") || "/";
  // Profile has its own account-menu entry rather than sharing Settings' highlight.
  if (href === "/settings") {
    return (
      (path === "/settings" || path.startsWith("/settings/")) &&
      path !== "/settings/profile" &&
      !path.startsWith("/settings/profile/")
    );
  }
  if (href === "/issues" || href === "/bugs") {
    return (
      path === "/notes" ||
      path === "/issues" ||
      path === "/bugs" ||
      // An idea opens from the Ideas tab, so it stays in Product (#idea-table).
      path.startsWith("/ideas/") ||
      ((path.startsWith("/issues/") || path.startsWith("/bugs/")) &&
        path !== "/issues/new" &&
        path !== "/bugs/new") ||
      // An issue's own page, `/<project-slug>/<number>` (#project-urls).
      isProjectIssuePath(path, { subpages: true })
    );
  }
  if (href === "/inbox") {
    return (
      path === "/inbox" ||
      path.startsWith("/inbox/") ||
      path === "/questions" ||
      path.startsWith("/questions/") ||
      path === "/redesigns" ||
      path.startsWith("/redesigns/")
    );
  }
  // Site admin covers every page under /admin, not only the users list it opens on.
  if (href === SITE_ADMIN_HREF) {
    return path === "/admin" || path.startsWith("/admin/");
  }
  return path === href || path.startsWith(`${href}/`);
}

/** The role a user really has, before any "View as" override. */
export function realRoleOf(flags: {
  isRealSuperAdmin?: boolean;
  isRealAdmin?: boolean;
}): AppRole {
  if (flags.isRealSuperAdmin) return "super_admin";
  if (flags.isRealAdmin) return "admin";
  return "user";
}

export const roleViewLabels: Record<AppRole, string> = {
  super_admin: "Super admin",
  admin: "Team lead (admin)",
  user: "Normal user",
};

/** Up to two initials for the account button, e.g. "Bob Builder" → "BB". */
export function initialsOf(name?: string | null): string {
  const clean = (name ?? "").trim();
  if (!clean) return "?";
  const base = clean.includes("@") ? clean.split("@")[0] : clean;
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  const letters =
    parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : base.slice(0, 2);
  return letters.toUpperCase();
}
