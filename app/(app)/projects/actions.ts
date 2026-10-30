"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth-helpers";
import { fieldError, fromZodError } from "@/lib/form-errors";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { setActiveProjectCookie } from "@/lib/project-context";
import { currentTenantIdFor, NO_TENANT_MESSAGE } from "@/lib/tenant-context";
import { isTenantAdmin } from "@/lib/agents/membership";
import { isSuperAdmin, type AppRole } from "@/lib/roles";
import { createMissionSchema, createTestMissions } from "@/lib/missions";
import {
  nextProjectSlug,
  projectNameSchema,
  projectSettingsSchema,
  projectSlugBase,
  parseRewardConfigFromFormData,
} from "./validation";
import {
  getPlatformRewardConfig,
  projectDefaultsFromPlatform,
} from "@/lib/points/platform-rewards";
import { parseProjectRewardConfig } from "@/lib/points/project-rewards";

export type ProjectActionResult = {
  error?: string;
  field?: string;
  fieldErrors?: Record<string, string>;
  message?: string;
};

function projectsMessage(key: "error" | "notice", message: string): string {
  return `/projects?${key}=${encodeURIComponent(message)}`;
}

/** The current tenant, only when the signed-in person owns it or is super admin. */
async function ownerTenantFor(
  userId: string,
  userRole?: AppRole | null,
): Promise<{ tenantId: string } | { error: string }> {
  const tenantId = await currentTenantIdFor(userId);
  if (!tenantId) return { error: NO_TENANT_MESSAGE };

  if (isSuperAdmin(userRole)) {
    return { tenantId };
  }

  const membership = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { role: true },
  });
  if (membership?.role !== "owner") {
    return { error: "Only a tenant owner can manage its projects." };
  }
  return { tenantId };
}

function projectInTenant(tenantId: string, projectId: string) {
  if (!projectId) return null;
  return prisma.project.findFirst({
    where: { id: projectId, tenantId },
    select: {
      id: true,
      name: true,
      archivedAt: true,
      _count: { select: { bugs: true } },
    },
  });
}

export async function updateProjectAction(
  _previous: ProjectActionResult | undefined,
  formData: FormData,
): Promise<ProjectActionResult> {
  const user = await requireUser();
  const tenantId = await currentTenantIdFor(user.id);
  if (!tenantId) return { error: NO_TENANT_MESSAGE };
  if (!(await isTenantAdmin(user, tenantId))) return { error: "Only workspace owners and admins can change project settings." };

  const parsed = projectSettingsSchema.safeParse({
    name: formData.get("name"),
    goal: formData.get("goal"),
    repoUrl: formData.get("repoUrl"),
    stagingUrl: formData.get("stagingUrl"),
  });
  if (!parsed.success) return fromZodError(parsed.error, "Check the project settings.");
  const slug = String(formData.get("slug") ?? "").trim();
  const project = await prisma.project.findFirst({
    where: { tenantId, slug },
    select: { id: true, name: true, goal: true, repoUrl: true, stagingUrl: true, rewardConfig: true },
  });
  if (!project) return { error: "Project not found." };

  const rawReward = parseRewardConfigFromFormData(formData);
  const platformBase = projectDefaultsFromPlatform(await getPlatformRewardConfig(prisma));
  const rewardConfig = rawReward ? parseProjectRewardConfig(rawReward, platformBase) : undefined;

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of ["name", "goal", "repoUrl", "stagingUrl"] as const) {
    if (project[field] !== parsed.data[field]) {
      changes[field] = { from: project[field], to: parsed.data[field] };
    }
  }
  if (rewardConfig !== undefined && JSON.stringify(project.rewardConfig) !== JSON.stringify(rewardConfig)) {
    changes.rewardConfig = { from: project.rewardConfig, to: rewardConfig };
  }

  if (Object.keys(changes).length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: project.id },
        data: {
          ...parsed.data,
          ...(rewardConfig !== undefined ? { rewardConfig } : {}),
        },
      });
      await tx.projectAuditEvent.create({
        data: {
          tenantId,
          projectId: project.id,
          actorUserId: user.id,
          action: "settings.updated",
          changes: changes as Prisma.InputJsonValue,
        },
      });
    });
  }
  revalidatePath(`/projects/${slug}/settings`);
  revalidatePath("/issues");
  return {};
}

/** Create a route/role/viewport mission set for a project (#619). */
export async function createTestMissionAction(
  _previous: ProjectActionResult | undefined,
  formData: FormData,
): Promise<ProjectActionResult> {
  const user = await requireUser();
  const tenantId = await currentTenantIdFor(user.id);
  if (!tenantId) return { error: NO_TENANT_MESSAGE };

  const projectId = String(formData.get("projectId") ?? "").trim();
  const project = projectId ? await prisma.project.findFirst({
    where: { id: projectId, tenantId },
    select: { id: true },
  }) : null;
  if (!project) return { error: "Project not found." };
  if (!(await isTenantAdmin(user, tenantId))) {
    return { error: "Only project admins can manage test missions." };
  }

  const parsed = createMissionSchema.safeParse({
    routePattern: formData.get("routePattern"),
    brief: formData.get("brief"),
    roles: formData.getAll("roles"),
    viewports: formData.getAll("viewports"),
  });
  if (!parsed.success) return fromZodError(parsed.error, "Check the mission details");

  const result = await createTestMissions(project.id, parsed.data);
  revalidatePath("/projects");
  return result.count > 0
    ? { message: `Added ${result.count} test mission${result.count === 1 ? "" : "s"}.` }
    : { message: "Those route, role, and viewport missions already exist." };
}

/**
 * Create a project in the current tenant and make it active (#426).
 *
 * The slug is derived from the name; a second "Zedu Web" becomes
 * "zedu-web-2" rather than failing the person's click.
 */
export async function createProjectAction(
  _previous: ProjectActionResult | undefined,
  formData: FormData,
): Promise<ProjectActionResult> {
  const user = await requireUser();
  const tenantId = await currentTenantIdFor(user.id);
  if (!tenantId) return { error: NO_TENANT_MESSAGE };

  const parsed = projectNameSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return fromZodError(parsed.error, "Invalid project name");

  const existing = await prisma.project.findMany({
    where: { tenantId },
    select: { slug: true },
  });
  const slug = nextProjectSlug(
    projectSlugBase(parsed.data.name),
    new Set(existing.map((project) => project.slug)),
  );

  const rawReward = parseRewardConfigFromFormData(formData);
  const platformBase = projectDefaultsFromPlatform(await getPlatformRewardConfig(prisma));
  const rewardConfig = rawReward ? parseProjectRewardConfig(rawReward, platformBase) : null;

  let project: { id: string };
  try {
    project = await prisma.project.create({
      data: {
        tenantId,
        name: parsed.data.name,
        slug,
        rewardConfig: rewardConfig ?? undefined,
        workflow: { create: {} },
      },
      select: { id: true },
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      return fieldError("name", "A project with that name already exists.");
    }
    throw error;
  }

  await setActiveProjectCookie(project.id);
  revalidatePath("/", "layout");
  revalidatePath("/projects");
  revalidatePath("/issues");
  redirect("/issues");
}

/**
 * Switch the active project, but only within the person's current tenant.
 *
 * Returns nothing: the switcher only offers projects the tenant owns, and a
 * forged id is ignored rather than exposing whether another tenant has it.
 */
export async function switchProjectAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tenantId = await currentTenantIdFor(user.id);
  if (!tenantId) return;

  const projectId = String(formData.get("projectId") ?? "").trim();
  if (!projectId) return;

  // The tenantId is part of the lookup, not the cookie: a forged project id
  // from another tenant is simply not found.
  const project = await prisma.project.findFirst({
    where: { id: projectId, tenantId, archivedAt: null },
    select: { id: true },
  });
  if (!project) return;

  await setActiveProjectCookie(project.id);
  revalidatePath("/", "layout");
  revalidatePath("/issues");
  redirect("/issues");
}

/** Archive or restore a project the tenant owner owns. */
export async function setProjectArchivedAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const owner = await ownerTenantFor(user.id, user.role);
  if ("error" in owner) redirect(projectsMessage("error", owner.error));

  const project = await projectInTenant(owner.tenantId, String(formData.get("projectId") ?? ""));
  if (!project) redirect(projectsMessage("error", "That project isn't in this workspace."));

  const archived = String(formData.get("archived") ?? "") === "true";
  if (Boolean(project.archivedAt) !== archived) {
    await prisma.project.update({
      where: { id: project.id },
      data: { archivedAt: archived ? new Date() : null },
    });
  }

  revalidatePath("/", "layout");
  revalidatePath("/projects");
  revalidatePath("/issues");
  redirect(projectsMessage("notice", archived ? "Project archived." : "Project restored."));
}

/** Delete a project after the owner types its name, and only when it has no issues. */
export async function deleteProjectAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const owner = await ownerTenantFor(user.id, user.role);
  if ("error" in owner) redirect(projectsMessage("error", owner.error));

  const project = await projectInTenant(owner.tenantId, String(formData.get("projectId") ?? ""));
  if (!project) redirect(projectsMessage("error", "That project isn't in this workspace."));

  if (project._count.bugs > 0) {
    redirect(
      projectsMessage("error", "This project still has issues. Archive it instead."),
    );
  }

  const typed = String(formData.get("confirmName") ?? "").trim();
  if (typed !== project.name) {
    redirect(projectsMessage("error", "Type the project's name exactly to confirm."));
  }

  try {
    await prisma.project.delete({ where: { id: project.id } });
  } catch (error) {
    console.error("[projects] deleteProjectAction failed", error);
    redirect(projectsMessage("error", "Couldn't delete this project. Archive it instead."));
  }

  revalidatePath("/", "layout");
  revalidatePath("/projects");
  revalidatePath("/issues");
  redirect(projectsMessage("notice", "Project deleted."));
}

export async function createApprovalRuleAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tenantId = await currentTenantIdFor(user.id);
  if (!tenantId) return;

  const projectId = String(formData.get("projectId") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim();
  const stage = String(formData.get("stage") ?? "before_merge").trim() as "before_offer" | "before_merge";
  const issueTypeId = String(formData.get("issueTypeId") ?? "").trim() || null;
  const fileGlob = String(formData.get("fileGlob") ?? "").trim() || null;

  if (!projectId || (stage !== "before_offer" && stage !== "before_merge")) return;

  const { createApprovalRule } = await import("@/lib/approvals");
  await createApprovalRule(
    user.id,
    tenantId,
    projectId,
    {
      stage,
      issueTypeId,
      fileGlob,
    },
  );

  if (slug) {
    revalidatePath(`/projects/${slug}/settings`);
  }
}

export async function deleteApprovalRuleAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tenantId = await currentTenantIdFor(user.id);
  if (!tenantId) return;

  const ruleId = String(formData.get("ruleId") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim();
  if (!ruleId) return;

  const { deleteApprovalRule } = await import("@/lib/approvals");
  await deleteApprovalRule(user.id, tenantId, ruleId);

  if (slug) {
    revalidatePath(`/projects/${slug}/settings`);
  }
}
