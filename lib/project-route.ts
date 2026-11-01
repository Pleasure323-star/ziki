import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth-helpers";
import { currentTenantIdFor } from "@/lib/tenant-context";
import { isReservedProjectSlug } from "@/lib/project-slug";

/**
 * The project a page shows comes from its URL's slug (#project-urls), never a
 * cookie. This resolves it and is the access check for every project page:
 *
 * - The slug is looked up among the workspaces the signed-in person belongs
 *   to (any workspace for the site super admin). No match is a 404, so a
 *   project you can't see looks the same as one that doesn't exist.
 * - Slugs are unique per workspace, so a slug two of your workspaces share
 *   resolves in the one you're in.
 * - When the project is in another of your workspaces, the request goes
 *   through /projects/<slug>/open, which makes that workspace current and
 *   comes back, so everything the page and its actions read agrees with the URL.
 */
export type ProjectContext = {
  user: Awaited<ReturnType<typeof requireUser>>;
  tenantId: string;
  project: { id: string; slug: string; name: string; goal: string | null; tenantId: string };
};

export const requireProject = cache(async (slug: string, returnTo?: string): Promise<ProjectContext> => {
  const user = await requireUser();
  const decoded = decodeURIComponent(slug);
  if (isReservedProjectSlug(decoded)) notFound();

  const memberships = user.role === "super_admin"
    ? null
    : (await prisma.membership.findMany({ where: { userId: user.id, tenant: { archivedAt: null } }, select: { tenantId: true } })).map((m) => m.tenantId);
  if (memberships && memberships.length === 0) notFound();

  const candidates = await prisma.project.findMany({
    where: { slug: decoded, archivedAt: null, ...(memberships ? { tenantId: { in: memberships } } : {}), tenant: { archivedAt: null } },
    select: { id: true, slug: true, name: true, goal: true, tenantId: true },
    orderBy: { createdAt: "asc" },
  });
  if (candidates.length === 0) notFound();

  const currentTenantId = await currentTenantIdFor(user.id);
  const project = candidates.find((candidate) => candidate.tenantId === currentTenantId) ?? candidates[0];
  if (project.tenantId !== currentTenantId) {
    // Switch to the project's workspace first, then come back to this page.
    const next = returnTo ?? `/${encodeURIComponent(project.slug)}`;
    redirect(`/projects/${encodeURIComponent(project.slug)}/open?tenant=${encodeURIComponent(project.tenantId)}&next=${encodeURIComponent(next)}`);
  }
  return { user, tenantId: project.tenantId, project };
});

/** The first project someone can open, for addresses with no slug (the site root, sign-in). */
export async function firstProjectSlugFor(userId: string): Promise<string | null> {
  const tenantId = await currentTenantIdFor(userId);
  if (!tenantId) return null;
  const project = await prisma.project.findFirst({ where: { tenantId, archivedAt: null }, orderBy: { createdAt: "asc" }, select: { slug: true } });
  return project?.slug ?? null;
}
