import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth-helpers";
import { firstProjectSlugFor } from "@/lib/project-route";
import { workspacePath } from "@/lib/project-paths";

/**
 * Where sign-in lands (#project-urls). Nothing names a project yet, so this
 * opens the dashboard of the first project in the current workspace,
 * `/<slug>/dashboard`, or the workspace picker when there is none.
 */
export default async function DashboardEntryPage() {
  const user = await requireUser();
  const slug = await firstProjectSlugFor(user.id);
  redirect(slug ? workspacePath(slug, "dashboard") : "/tenants");
}
