import { prisma } from "@/lib/prisma";
import { ensureDefaultPlatforms, platformScopeFor } from "@/lib/categories";
import { CategoryManager } from "@/components/category-manager";
import { loadOrg } from "../org-context";
import { OrgPageHeader, ReadOnlyNameList, ReadOnlyNote } from "../org-ui";

/* Distinct browser-tab title; the root layout appends "· Ziki". */
export const metadata = { title: "Platforms" };

/** The organization's platforms. Owners and admins manage them; members read them. */
export default async function OrgPlatformsPage() {
  const { user, org } = await loadOrg();
  if (!org) return null;

  const header = (
    <OrgPageHeader title="Platforms">
      A platform is a label on an issue in {org.name}, such as Web or Mobile. It is not a project.
      Every project in this organization shares this list, and another organization keeps its own.
    </OrgPageHeader>
  );

  const scope = await platformScopeFor(user);
  if (!scope.ok) {
    const platforms = await prisma.category.findMany({
      where: { tenantId: org.id },
      orderBy: { name: "asc" },
      select: { id: true, name: true, isActive: true },
    });
    return (
      <div className="space-y-4">
        {header}
        <ReadOnlyNote>Only owners and admins can add, rename or retire platforms.</ReadOnlyNote>
        <ReadOnlyNameList
          label="Platforms"
          empty="This organization has no platforms yet."
          items={platforms.map((platform) => ({
            id: platform.id,
            name: platform.name,
            inactive: !platform.isActive,
          }))}
        />
      </div>
    );
  }

  await ensureDefaultPlatforms(scope.tenantId);

  const [rows, usage] = await Promise.all([
    prisma.category.findMany({
      where: { tenantId: scope.tenantId },
      orderBy: { name: "asc" },
    }),
    prisma.bug.groupBy({
      by: ["categoryId", "isDeleted"],
      where: { tenantId: scope.tenantId, categoryId: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const totals = new Map<string, number>();
  const deletedCounts: Record<string, number> = {};
  for (const row of usage) {
    if (!row.categoryId) continue;
    totals.set(row.categoryId, (totals.get(row.categoryId) ?? 0) + row._count._all);
    if (row.isDeleted) deletedCounts[row.categoryId] = row._count._all;
  }

  const categories = rows.map((row) => ({
    ...row,
    _count: { bugs: totals.get(row.id) ?? 0 },
  }));

  return (
    <div className="space-y-6">
      {header}
      <CategoryManager initialCategories={categories} deletedCounts={deletedCounts} />
    </div>
  );
}
