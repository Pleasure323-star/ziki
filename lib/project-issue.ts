import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { resolveSessionUserId } from "@/lib/session-user";
import { viewerBugScope } from "@/lib/tenant-viewer";
import { isReservedProjectSlug } from "@/lib/project-slug";

/**
 * Finding the issue behind `/<project-slug>/<number>` (#project-urls). The
 * number is the organisation-wide `Bug.number`; the slug names the project
 * it belongs to.
 */

/** The `<number>` segment as an issue number, or null when it is not one. */
export function parseIssueNumber(raw: string): number | null {
  if (!/^[0-9]{1,9}$/.test(raw)) return null;
  const number = Number(raw);
  return number > 0 ? number : null;
}

export type ProjectIssue = { id: string; number: number; projectSlug: string; isDeleted: boolean };

export type ProjectIssueLookup =
  /** The issue, in the project the URL names. */
  | { kind: "found"; issue: ProjectIssue }
  /** The viewer's organisation has the number, in another project: redirect to it. */
  | { kind: "moved"; issue: ProjectIssue }
  /** Another organisation the viewer belongs to has it (#519): offer the switch. */
  | { kind: "elsewhere"; issueId: string };

const select = { id: true, number: true, isDeleted: true, project: { select: { slug: true } } } as const;

function toIssue(row: { id: string; number: number; isDeleted: boolean; project: { slug: string } }): ProjectIssue {
  return { id: row.id, number: row.number, projectSlug: row.project.slug, isDeleted: row.isDeleted };
}

/**
 * Looks the issue up for the viewer, once per request (the layout, metadata
 * and page all ask).
 *
 * Signed in, the number is read in the active organisation. When the project
 * there differs from the URL's, an issue under that slug and number in another
 * of the viewer's organisations wins (the link was meant for it); otherwise
 * the URL is a redirect to the issue's real project.
 *
 * Signed out (a link-preview bot, #117), slugs are only unique per
 * organisation, so the issue is used only when exactly one matches.
 *
 * A top-level route's name is never a project (lib/project-slug.ts), so a
 * path such as `/settings/12` that no page serves is a plain 404.
 */
export const findProjectIssue = cache(async (projectSlug: string, number: number): Promise<ProjectIssueLookup | null> => {
  if (isReservedProjectSlug(projectSlug)) return null;
  const scope = await viewerBugScope();
  if (!("tenantId" in scope)) {
    const rows = await prisma.bug.findMany({ where: { number, project: { slug: projectSlug } }, select, take: 2 });
    return rows.length === 1 ? { kind: "found", issue: toIssue(rows[0]) } : null;
  }

  const row = await prisma.bug.findFirst({ where: { number, ...scope }, select });
  if (row && row.project.slug === projectSlug) return { kind: "found", issue: toIssue(row) };

  const resolved = await resolveSessionUserId();
  if ("userId" in resolved) {
    const other = await prisma.bug.findFirst({
      where: {
        number,
        isDeleted: false,
        project: { slug: projectSlug },
        ...(typeof scope.tenantId === "string" ? { tenantId: { not: scope.tenantId } } : {}),
        tenant: { memberships: { some: { userId: resolved.userId } } },
      },
      select: { id: true },
    });
    if (other) return { kind: "elsewhere", issueId: other.id };
  }

  return row ? { kind: "moved", issue: toIssue(row) } : null;
});
