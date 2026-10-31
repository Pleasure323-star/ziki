import { permanentRedirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { COMMENT_PARAM, parseCommentTarget } from "@/lib/comment-window";
import { ideaPath, issueHref, parseIssueRef, queryString } from "@/lib/issue-ref";
import { viewerBugScope } from "@/lib/tenant-viewer";

/**
 * Sends an old `/issues/<ref><suffix>` address to the issue's project URL
 * (#project-urls), or to the idea an old issue number became (#idea-table).
 * Returns only when there is nowhere to send it.
 *
 * A number (`123`, `ZE-123`) means something only inside the viewer's
 * organisation; an internal id is looked up in it too, or anywhere for a
 * signed-out link-preview bot (#117), which then sees the title and status
 * at the new address.
 */
export async function redirectLegacyIssue(
  rawRef: string,
  suffix: string,
  query: Record<string, string | string[] | undefined>,
): Promise<void> {
  const ref = parseIssueRef(rawRef);
  const scope = await viewerBugScope();
  const tenantId = typeof scope.tenantId === "string" ? scope.tenantId : null;
  const where =
    ref.kind === "id" ? { id: ref.id, ...scope } : tenantId ? { tenantId, number: ref.number } : null;
  const bug = where
    ? await prisma.bug.findFirst({ where, select: { number: true, project: { select: { slug: true } } } })
    : null;
  if (bug) {
    const comment = parseCommentTarget(query[COMMENT_PARAM]);
    permanentRedirect(`${issueHref(bug, suffix)}${queryString(query)}${comment ? `#comment-${comment}` : ""}`);
  }

  // #idea-table: ideas left the issues table but kept their old id and
  // number, so a link from before still lands on the idea.
  if (tenantId) {
    const idea = await prisma.idea.findFirst({
      where: { tenantId, ...(ref.kind === "number" ? { legacyBugNumber: ref.number } : { id: ref.id }) },
      select: { number: true },
    });
    if (idea) permanentRedirect(ideaPath(idea.number));
  }
}
