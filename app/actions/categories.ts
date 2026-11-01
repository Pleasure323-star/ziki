"use server";

import { fromZodError } from "@/lib/form-errors";
import { revalidatePath } from "next/cache";
import { revalidateIssue } from "@/lib/revalidate-issue";
import { expireTag, TAGS } from "@/lib/cache-tags";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth-helpers";
import { platformScopeFor } from "@/lib/categories";
import { categorySchema } from "@/lib/validations/issue";
import { categoryChangedSummary } from "@/lib/activity-log";

export type CategoryActionResult = {
  error?: string;
  ok?: boolean;
};

function revalidatePlatforms() {
  expireTag(TAGS.platforms);
  revalidatePath("/[project]/org", "layout");
  revalidatePath("/[project]", "layout");
  revalidatePath("/bugs/new");
  revalidatePath("/bugs");
}

export async function createCategoryAction(
  formData: FormData,
): Promise<CategoryActionResult> {
  const scope = await platformScopeFor(await requireUser());
  if (!scope.ok) return { error: scope.error };

  const parsed = categorySchema.safeParse({
    name: formData.get("name"),
  });

  if (!parsed.success) {
    return fromZodError(parsed.error, "Invalid platform name");
  }

  const normalizedName = parsed.data.name.trim();

  const existing = await prisma.category.findFirst({
    where: {
      tenantId: scope.tenantId,
      name: {
        equals: normalizedName,
        mode: "insensitive",
      },
    },
  });

  if (existing) {
    return { error: `A platform named "${existing.name}" already exists.` };
  }

  try {
    await prisma.category.create({
      data: {
        tenantId: scope.tenantId,
        name: normalizedName,
        isActive: true,
      },
    });
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "P2002"
    ) {
      return { error: `A platform named "${normalizedName}" already exists.` };
    }
    throw err;
  }

  revalidatePlatforms();
  return { ok: true };
}

export async function updateCategoryAction(
  categoryId: string,
  formData: FormData,
): Promise<CategoryActionResult> {
  const scope = await platformScopeFor(await requireUser());
  if (!scope.ok) return { error: scope.error };

  const parsed = categorySchema.safeParse({
    name: formData.get("name"),
  });

  if (!parsed.success) {
    return fromZodError(parsed.error, "Invalid platform name");
  }

  const category = await prisma.category.findFirst({
    where: { id: categoryId, tenantId: scope.tenantId },
  });

  if (!category) {
    return { error: "Platform not found" };
  }

  const normalizedName = parsed.data.name.trim();

  const duplicate = await prisma.category.findFirst({
    where: {
      tenantId: scope.tenantId,
      name: {
        equals: normalizedName,
        mode: "insensitive",
      },
      NOT: { id: categoryId },
    },
  });

  if (duplicate) {
    return { error: `A platform named "${duplicate.name}" already exists.` };
  }

  let linkedBugIds: string[] = [];

  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.category.findFirst({
        where: { id: categoryId, tenantId: scope.tenantId },
      });
      if (!current) {
        return;
      }

      await tx.category.update({
        where: { id: categoryId },
        data: { name: normalizedName },
      });

      if (current.name !== normalizedName) {
        const linkedBugs = await tx.bug.findMany({
          where: { categoryId, tenantId: scope.tenantId },
          select: { id: true },
        });

        if (linkedBugs.length > 0) {
          linkedBugIds = linkedBugs.map((b) => b.id);
          await tx.bugActivity.createMany({
            data: linkedBugs.map((b) => ({
              bugId: b.id,
              actorId: scope.userId,
              type: "category_changed",
              summary: categoryChangedSummary(current.name, normalizedName),
              metadata: {
                field: "category",
                from: current.name,
                to: normalizedName,
              },
            })),
          });
        }
      }
    });
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "P2002"
    ) {
      return { error: `A platform named "${normalizedName}" already exists.` };
    }
    throw err;
  }

  revalidatePlatforms();
  for (const bugId of linkedBugIds) {
    revalidateIssue();
    revalidatePath(`/bugs/${bugId}`);
  }
  return { ok: true };
}

export async function toggleCategoryStatusAction(
  categoryId: string,
): Promise<CategoryActionResult> {
  const scope = await platformScopeFor(await requireUser());
  if (!scope.ok) return { error: scope.error };

  const category = await prisma.category.findFirst({
    where: { id: categoryId, tenantId: scope.tenantId },
  });

  if (!category) {
    return { error: "Platform not found" };
  }

  await prisma.category.update({
    where: { id: categoryId },
    data: { isActive: !category.isActive },
  });

  revalidatePlatforms();
  return { ok: true };
}

export async function deleteCategoryAction(
  categoryId: string,
): Promise<CategoryActionResult> {
  const scope = await platformScopeFor(await requireUser());
  if (!scope.ok) return { error: scope.error };

  const category = await prisma.category.findFirst({
    where: { id: categoryId, tenantId: scope.tenantId },
  });

  if (!category) {
    return { error: "Platform not found" };
  }

  const bugCount = await prisma.bug.count({
    where: { categoryId },
  });

  if (bugCount > 0) {
    return {
      error: `Cannot delete platform: it is currently used by ${bugCount} issue${bugCount === 1 ? "" : "s"}. Please reassign or deactivate it instead.`,
    };
  }

  try {
    await prisma.category.delete({
      where: { id: categoryId },
    });
  } catch {
    return { error: "Failed to delete platform" };
  }

  revalidatePlatforms();
  return { ok: true };
}
