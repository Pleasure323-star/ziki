"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/auth-helpers";
import { isTenantAdmin } from "@/lib/agents/membership";
import { currentTenantIdFor, NO_TENANT_MESSAGE } from "@/lib/tenant-context";
import { prisma } from "@/lib/prisma";
import { invalidateWorkflow } from "@/lib/workflow";
import { workflowSettingsSchema, workflowValues } from "@/lib/workflow-config";

export type WorkflowActionResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

const NUMERIC_FIELDS = [
  "ideaThreshold",
  "confirmationsNeeded",
  "verdictsNeeded",
  "offerWindowSeconds",
  "heartbeatMinutes",
  "deliveryMinutes",
  "maxActiveClaims",
  "volunteerWindowSeconds",
  "abandonCheckMinutes",
  "abandonThreshold",
  "closeThreshold",
] as const;

async function projectSettingsAccess(slug: string) {
  const user = await requireUser();
  const tenantId = await currentTenantIdFor(user.id);
  if (!tenantId) return { ok: false as const, error: NO_TENANT_MESSAGE };
  if (!(await isTenantAdmin(user, tenantId))) {
    return { ok: false as const, error: "Only workspace owners and admins can change workflow settings." };
  }
  const project = await prisma.project.findFirst({
    where: { tenantId, slug },
    select: { id: true, slug: true, workflow: true },
  });
  if (!project) return { ok: false as const, error: "Project not found." };
  return { ok: true as const, user, tenantId, project };
}

/** Save one project's workflow dials (#595). Tenant owners/admins only. */
export async function updateProjectWorkflowAction(
  _previous: WorkflowActionResult | undefined,
  formData: FormData,
): Promise<WorkflowActionResult> {
  const slug = String(formData.get("slug") ?? "").trim();
  const access = await projectSettingsAccess(slug);
  if (!access.ok) return access;

  const raw: Record<string, unknown> = {
    autoMerge: formData.get("autoMerge") === "on",
  };
  for (const field of NUMERIC_FIELDS) raw[field] = Number(formData.get(field));

  const parsed = workflowSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = typeof issue.path[0] === "string" ? issue.path[0] : "";
      if (field && !fieldErrors[field]) fieldErrors[field] = issue.message;
    }
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the workflow settings.",
      fieldErrors,
    };
  }

  const current = workflowValues(access.project.workflow);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of [...NUMERIC_FIELDS, "autoMerge"] as const) {
    if (current[field] !== parsed.data[field]) {
      changes[field] = { from: current[field], to: parsed.data[field] };
    }
  }

  if (Object.keys(changes).length > 0) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.projectWorkflow.upsert({
          where: { projectId: access.project.id },
          update: parsed.data,
          create: { projectId: access.project.id, ...parsed.data },
        });
        await tx.projectAuditEvent.create({
          data: {
            tenantId: access.tenantId,
            projectId: access.project.id,
            actorUserId: access.user.id,
            action: "workflow.updated",
            changes: changes as Prisma.InputJsonValue,
          },
        });
      });
    } catch {
      // The transaction rolled back: the old settings still apply.
      return { ok: false, error: "Couldn't save the workflow settings. Try again." };
    }
    invalidateWorkflow(access.project.id);
  }

  revalidatePath(`/projects/${encodeURIComponent(access.project.slug)}/settings`);
  return { ok: true };
}
