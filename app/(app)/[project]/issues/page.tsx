import { redirect } from "next/navigation";
import { requireProject } from "@/lib/project-route";
import { issuesPath } from "@/lib/project-paths";

/** `/<slug>/issues`: every issue, the All list. */
export default async function IssuesIndexPage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  const { project: resolved } = await requireProject(project, `/${project}/issues`);
  redirect(issuesPath(resolved.slug, "all"));
}
