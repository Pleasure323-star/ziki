import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth-helpers";
import { isReservedProjectSlug } from "@/lib/project-slug";
import { activeProjectIdFor } from "@/lib/project-context";
import { currentTenantIdFor } from "@/lib/tenant-context";

type Props = { params: Promise<{ project: string }> };

/**
 * `/<project-slug>`: that project's issues (#project-urls). The issue list
 * shows the active project, so this opens the list with the project made
 * active (`/projects/<slug>/open` sets it). A slug no project in the viewer's
 * organisation has is a 404, like any other unknown top-level address.
 */
export default async function ProjectHomePage({ params }: Props) {
  const { project: slug } = await params;
  const user = await requireUser();
  const tenantId = await currentTenantIdFor(user.id);
  const project = tenantId && !isReservedProjectSlug(slug)
    ? await prisma.project.findFirst({ where: { tenantId, slug, archivedAt: null }, select: { id: true, slug: true } })
    : null;
  if (!project) notFound();
  if ((await activeProjectIdFor(prisma, tenantId)) === project.id) redirect("/issues");
  redirect(`/projects/${encodeURIComponent(project.slug)}/open`);
}
