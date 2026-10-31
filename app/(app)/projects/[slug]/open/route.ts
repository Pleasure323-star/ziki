import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { BASE_PATH } from "@/lib/base-path";
import { setActiveProjectCookie } from "@/lib/project-context";
import { resolveSessionUserId } from "@/lib/session-user";
import { currentTenantIdFor } from "@/lib/tenant-context";

/** A relative Location, so the browser stays on the host it asked (see notifications/[id]/route.ts, #416). */
function redirectTo(path: string): NextResponse {
  return new NextResponse(null, { status: 307, headers: { Location: `${BASE_PATH}${path}` } });
}

/**
 * Makes a project of the viewer's current organisation the active one on
 * this device and opens its issues (#project-urls): where `/<project-slug>`
 * leads. The project is looked up inside the current tenant, as
 * `switchProjectAction` does, so a slug from another organisation changes
 * nothing.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const resolved = await resolveSessionUserId();
  if ("error" in resolved) return redirectTo("/login");

  const tenantId = await currentTenantIdFor(resolved.userId);
  const project = tenantId
    ? await prisma.project.findFirst({ where: { tenantId, slug, archivedAt: null }, select: { id: true } })
    : null;
  if (project) await setActiveProjectCookie(project.id);
  return redirectTo("/issues");
}
