import { redirect } from "next/navigation";
import { requireProject } from "@/lib/project-route";
import { ideasPath } from "@/lib/project-paths";

type Props = { params: Promise<{ project: string }> };

/**
 * `/<project-slug>`: the project's home, its Ideas list (#project-urls). The
 * slug picks the project and lib/project-route.ts checks access: a project you
 * can't see is a 404, like any unknown address.
 */
export default async function ProjectHomePage({ params }: Props) {
  const { project: slug } = await params;
  const { project } = await requireProject(slug, `/${slug}`);
  redirect(ideasPath(project.slug));
}
