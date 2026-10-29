import Link from "next/link";
import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { activeProjectIdFor } from "@/lib/project-context";
import { currentTenantIdFor, NO_TENANT_MESSAGE } from "@/lib/tenant-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyProjectIdButton } from "./copy-project-id";
import { CreateProjectForm } from "./create-project-form";
import {
  deleteProjectAction,
  setProjectArchivedAction,
  switchProjectAction,
} from "./actions";
import { isTenantAdmin, isTenantAdminRole } from "@/lib/agents/membership";
import { isSuperAdmin } from "@/lib/roles";
import { MissionCoverage } from "./mission-coverage";
import { ProjectRewardRulesDisplay } from "@/components/project-reward-rules-display";
import {
  getPlatformRewardConfig,
  projectDefaultsFromPlatform,
} from "@/lib/points/platform-rewards";
import { parseProjectRewardConfig } from "@/lib/points/project-rewards";

/* Distinct browser-tab title; the root layout appends "· Ziki". */
export const metadata = { title: "Projects" };

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; notice?: string | string[] }>;
}) {
  const user = await requireUser();
  const {
    error: errorParam,
    notice: noticeParam,
  } = await searchParams;
  const error = typeof errorParam === "string" ? errorParam : "";
  const notice = typeof noticeParam === "string" ? noticeParam : "";
  const tenantId = await currentTenantIdFor(user.id);

  if (!tenantId) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-2xl font-extrabold tracking-tight text-zk-text">Projects</h1>
        <div className="rounded-xl border border-zk-warn-bd bg-zk-warn-bg p-4 text-sm text-zk-warn-fg">
          <p>{NO_TENANT_MESSAGE}</p>
          <div className="mt-3">
            <Link
              href="/tenants"
              className="inline-flex items-center justify-center rounded-full bg-electric-blue-strong px-3.5 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              Create or join a workspace &rarr;
            </Link>
          </div>
        </div>
      </div>
    );
  }
  const canManageProjects = await isTenantAdmin(user, tenantId);

  const [tenant, projects, activeProjectId, membership, platformRewards] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    }),
    prisma.project.findMany({
      where: { tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        archivedAt: true,
        createdAt: true,
        rewardConfig: true,
        _count: { select: { bugs: true } },
        testMissions: {
          select: {
            id: true,
            routePattern: true,
            brief: true,
            role: true,
            viewport: true,
            lastCoveredAt: true,
            issuesFiled: true,
          },
          orderBy: [{ routePattern: "asc" }, { role: "asc" }, { viewport: "asc" }],
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    activeProjectIdFor(prisma, tenantId),
    prisma.membership.findUnique({
      where: { tenantId_userId: { tenantId, userId: user.id } },
      select: { role: true },
    }),
    getPlatformRewardConfig(prisma),
  ]);
  const platformDefaults = projectDefaultsFromPlatform(platformRewards);
  const isOwner = membership?.role === "owner" || isSuperAdmin(user.role);
  const canManageMissions = isTenantAdminRole(membership?.role, user.role);
  const activeProjects = projects.filter((project) => !project.archivedAt);
  const archivedProjects = projects.filter((project) => project.archivedAt);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-1">
        <Link href="/issues" className="text-sm text-zk-accent hover:underline">
          ← Back to issues
        </Link>
        <h1 className="text-2xl font-extrabold tracking-tight text-zk-text">Projects</h1>
        <p className="text-sm text-zk-text2">
          A project is one product inside {tenant?.name ?? "your workspace"}, such as a web app.
          The issue list follows the project selected in the bar. A platform, such as Web or Mobile,
          is a label on an issue, not another project.
        </p>
      </div>

      {error ? (
        <p className="rounded-[14px] border border-zk-bad-bd bg-zk-bad-bg px-3 py-2 text-sm text-zk-bad-fg">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-[14px] border border-zk-border bg-zk-ok-bg px-3 py-2 text-sm text-zk-ok-fg">
          {notice}
        </p>
      ) : null}

      <section className="rounded-[20px] border border-zk-border bg-zk-surface p-4 sm:p-6">
        <h2 className="text-base font-semibold text-zk-text">
          Create a project
        </h2>
        <CreateProjectForm defaults={platformDefaults} />
      </section>

      <section className="overflow-hidden rounded-[20px] border border-zk-border bg-zk-surface">
        <div className="border-b border-zk-border bg-zk-tint px-4 py-3 sm:px-6">
          <h2 className="text-base font-semibold text-zk-text">
            Your projects
          </h2>
          <p className="mt-0.5 text-xs text-zk-muted">
            Switching here also changes the project shown in the header.
          </p>
        </div>
        {activeProjects.length === 0 ? (
          archivedProjects.length > 0 ? (
            <p className="px-4 py-6 text-sm text-zk-text2 sm:px-6">
              No active projects. Restore one below or create a new one.
            </p>
          ) : (
            <div className="space-y-2 px-4 py-6 text-sm text-zk-text2 sm:px-6">
              <p className="font-medium text-zk-text">No projects yet. Create the first one above.</p>
              <p>
                Make one project per product you track, so each gets its own issues. For example, a
                software team might have <span className="font-medium">Web app</span>,{" "}
                <span className="font-medium">iOS app</span> and <span className="font-medium">Desktop app</span>;
                an agency might have one per client.
              </p>
              <p>
                Each project also gets a short id made from its name (Web app → <code>web-app</code>), used in
                links and by agents.
              </p>
            </div>
          )
        ) : (
          <ul className="divide-y divide-zk-border">
            {activeProjects.map((project) => {
              const active = project.id === activeProjectId;
              return (
                <li
                  key={project.id}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium text-zk-text">
                      <span className="truncate">{project.name}</span>
                      {active ? (
                        <Badge className="rounded-full bg-zk-tint text-zk-accent ring-1 ring-zk-border">
                          Active
                        </Badge>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-xs text-zk-muted">
                      {project.slug} · {project._count.bugs}{" "}
                      {project._count.bugs === 1 ? "issue" : "issues"}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-zk-muted">Project ID:</span>
                      <code className="rounded bg-zk-chip px-1.5 py-0.5 font-mono text-[11px] text-zk-text2">
                        {project.id}
                      </code>
                      <CopyProjectIdButton projectId={project.id} />
                      {canManageProjects ? (
                        <Link href={`/projects/${encodeURIComponent(project.slug)}/settings`} className="text-xs font-medium text-zk-accent hover:underline">Settings</Link>
                      ) : null}
                    </div>
                    <div className="mt-3">
                      <ProjectRewardRulesDisplay
                        rewardConfig={parseProjectRewardConfig(project.rewardConfig, platformDefaults)}
                        defaults={platformDefaults}
                        customized={Boolean(project.rewardConfig)}
                      />
                    </div>
                    <MissionCoverage
                      projectId={project.id}
                      canManage={canManageMissions}
                      missions={project.testMissions.map((mission) => ({
                        ...mission,
                        lastCoveredAt: mission.lastCoveredAt?.toISOString() ?? null,
                      }))}
                    />

                    {isOwner ? (
                      <details className="mt-3 text-xs text-zk-text2">
                        <summary className="cursor-pointer font-medium text-zk-text2">
                          Archive or delete
                        </summary>
                        <div className="mt-2 space-y-4 rounded-xl border border-zk-border bg-zk-tint p-3">
                          <form action={setProjectArchivedAction}>
                            <input type="hidden" name="projectId" value={project.id} />
                            <input type="hidden" name="archived" value="true" />
                            <Button type="submit" variant="secondary">
                              Archive project
                            </Button>
                          </form>

                          <form action={deleteProjectAction} className="space-y-1">
                            <input type="hidden" name="projectId" value={project.id} />
                            <p className="font-medium text-zk-text2">Delete project</p>
                            <p>
                              Only works when the project has no issues. Otherwise archive it.
                            </p>
                            <label
                              htmlFor={`confirm-delete-${project.id}`}
                              className="block text-xs text-zk-text2"
                            >
                              Type {project.name} to confirm deleting it
                            </label>
                            <div className="flex flex-wrap items-center gap-2">
                              <input
                                id={`confirm-delete-${project.id}`}
                                name="confirmName"
                                placeholder={`Type ${project.name}`}
                                autoComplete="off"
                                required
                                className="min-w-0 flex-1 rounded-xl border border-zk-border px-2 py-1 text-sm text-zk-text"
                              />
                              <Button type="submit" variant="danger-secondary">
                                Delete project
                              </Button>
                            </div>
                          </form>
                        </div>
                      </details>
                    ) : null}
                  </div>
                  {active ? null : (
                    <form action={switchProjectAction}>
                      <input type="hidden" name="projectId" value={project.id} />
                      <Button type="submit" variant="secondary">
                        Switch to {project.name}
                      </Button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {isOwner && archivedProjects.length > 0 ? (
        <section className="overflow-hidden rounded-[20px] border border-zk-border bg-zk-surface">
          <div className="border-b border-zk-border bg-zk-tint px-4 py-3 sm:px-6">
            <h2 className="text-base font-semibold text-zk-text">Archived projects</h2>
            <p className="mt-0.5 text-xs text-zk-muted">
              Archived projects are hidden from the switcher and can&apos;t be selected.
              Restore one to use it again.
            </p>
          </div>
          <ul className="divide-y divide-zk-border">
            {archivedProjects.map((project) => (
              <li key={project.id} className="space-y-3 px-4 py-3 sm:px-6">
                <div>
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-zk-text">
                    <span className="truncate">{project.name}</span>
                    <Badge className="rounded-full bg-zk-warn-bg text-zk-warn-fg ring-1 ring-zk-warn-bd">
                      Archived
                    </Badge>
                  </p>
                  <p className="mt-0.5 text-xs text-zk-muted">
                    {project.slug} · {project._count.bugs}{" "}
                    {project._count.bugs === 1 ? "issue" : "issues"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <form action={setProjectArchivedAction}>
                    <input type="hidden" name="projectId" value={project.id} />
                    <input type="hidden" name="archived" value="false" />
                    <Button type="submit" variant="secondary">
                      Restore {project.name}
                    </Button>
                  </form>
                  <form action={deleteProjectAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="projectId" value={project.id} />
                    <input
                      id={`confirm-delete-archived-${project.id}`}
                      name="confirmName"
                      aria-label={`Type ${project.name} to confirm deleting it`}
                      placeholder={`Type ${project.name}`}
                      autoComplete="off"
                      required
                      className="rounded-xl border border-zk-border px-2 py-1 text-sm text-zk-text"
                    />
                    <Button type="submit" variant="danger-secondary">
                      Delete {project.name}
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
