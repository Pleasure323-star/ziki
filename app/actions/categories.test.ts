import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  // lib/lookups (#297): the actions expire the cached lists they change.
  unstable_cache: (fn: unknown) => fn,
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "admin-1", role: "admin" }),
}));

vi.mock("@/lib/tenant-context", () => ({
  currentTenantIdFor: vi.fn().mockResolvedValue("tenant-ziki"),
}));

vi.mock("@/lib/prisma", () => {
  const db = {
    category: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    tenant: {
      findUnique: vi.fn().mockResolvedValue({ id: "tenant-ziki", name: "Ziki" }),
    },
    membership: {
      findUnique: vi.fn().mockResolvedValue({ role: "member" }),
    },
    bug: {
      findMany: vi.fn(),
    },
    bugActivity: {
      createMany: vi.fn(),
    },
    $transaction: vi.fn(async (fn: (client: typeof db) => unknown) => fn(db)),
  };
  return { prisma: db };
});

import { prisma } from "@/lib/prisma";
import { updateTag } from "next/cache";
import { TAGS } from "@/lib/cache-tags";
import { requireUser } from "@/lib/auth-helpers";
import { currentTenantIdFor } from "@/lib/tenant-context";
import { createCategoryAction, updateCategoryAction } from "./categories";

const findFirstMock = vi.mocked(prisma.category.findFirst) as unknown as ReturnType<typeof vi.fn>;
const createMock = vi.mocked(prisma.category.create) as unknown as ReturnType<typeof vi.fn>;
const updateMock = vi.mocked(prisma.category.update) as unknown as ReturnType<typeof vi.fn>;
const bugFindManyMock = vi.mocked(prisma.bug.findMany) as unknown as ReturnType<typeof vi.fn>;
const bugActivityCreateManyMock = vi.mocked(prisma.bugActivity.createMany) as unknown as ReturnType<typeof vi.fn>;

describe("categories actions duplicate checks (#139)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createCategoryAction", () => {
    it("rejects case-insensitive duplicate category names", async () => {
      findFirstMock.mockResolvedValue({ id: "cat-1", name: "Web" });

      const formData = new FormData();
      formData.set("name", "web ");

      const result = await createCategoryAction(formData);

      expect(result.error).toBe('A platform named "Web" already exists.');
      expect(findFirstMock).toHaveBeenCalledWith({
        where: {
          tenantId: "tenant-ziki",
          name: {
            equals: "web",
            mode: "insensitive",
          },
        },
      });
      expect(createMock).not.toHaveBeenCalled();
    });

    it("creates category when name is unique", async () => {
      findFirstMock.mockResolvedValue(null);
      createMock.mockResolvedValue({ id: "cat-2", name: "Mobile", isActive: true });

      const formData = new FormData();
      formData.set("name", "  Mobile  ");

      const result = await createCategoryAction(formData);

      expect(result.ok).toBe(true);
      expect(createMock).toHaveBeenCalledWith({
        data: {
          tenantId: "tenant-ziki",
          name: "Mobile",
          isActive: true,
        },
      });
      // The report form and filters read a cached list; it must expire.
      expect(updateTag).toHaveBeenCalledWith(TAGS.platforms);
    });

    it("refuses a member of the organization", async () => {
      vi.mocked(requireUser).mockResolvedValueOnce({ id: "member-1", role: "user" } as never);
      vi.mocked(prisma.membership.findUnique).mockResolvedValueOnce({ role: "member" } as never);

      const formData = new FormData();
      formData.set("name", "Cloud");

      const result = await createCategoryAction(formData);

      expect(result.error).toEqual(expect.any(String));
      expect(createMock).not.toHaveBeenCalled();
    });

    it("refuses when no organization is open", async () => {
      vi.mocked(currentTenantIdFor).mockResolvedValueOnce(null);

      const formData = new FormData();
      formData.set("name", "Cloud");

      const result = await createCategoryAction(formData);

      expect(result.error).toEqual(expect.any(String));
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  describe("updateCategoryAction", () => {
    it("rejects case-insensitive duplicate when updating another category", async () => {
      findFirstMock
        .mockResolvedValueOnce({ id: "cat-1", name: "Desktop", tenantId: "tenant-ziki" })
        .mockResolvedValueOnce({ id: "cat-2", name: "Web" });

      const formData = new FormData();
      formData.set("name", "WEB");

      const result = await updateCategoryAction("cat-1", formData);

      expect(result.error).toBe('A platform named "Web" already exists.');
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("records BugActivity entries on linked issues when category is renamed (#365)", async () => {
      findFirstMock
        .mockResolvedValueOnce({ id: "cat-1", name: "Web", tenantId: "tenant-ziki" })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "cat-1", name: "Web", tenantId: "tenant-ziki" });
      updateMock.mockResolvedValue({ id: "cat-1", name: "Frontend" });
      bugFindManyMock.mockResolvedValue([{ id: "bug-101" }, { id: "bug-102" }]);
      bugActivityCreateManyMock.mockResolvedValue({ count: 2 });

      const formData = new FormData();
      formData.set("name", "Frontend");

      const result = await updateCategoryAction("cat-1", formData);

      expect(result.ok).toBe(true);
      expect(updateMock).toHaveBeenCalledWith({
        where: { id: "cat-1" },
        data: { name: "Frontend" },
      });
      expect(bugFindManyMock).toHaveBeenCalledWith({
        where: { categoryId: "cat-1", tenantId: "tenant-ziki" },
        select: { id: true },
      });
      expect(bugActivityCreateManyMock).toHaveBeenCalledWith({
        data: [
          {
            bugId: "bug-101",
            actorId: "admin-1",
            type: "category_changed",
            summary: "changed category from Web to Frontend",
            metadata: {
              field: "category",
              from: "Web",
              to: "Frontend",
            },
          },
          {
            bugId: "bug-102",
            actorId: "admin-1",
            type: "category_changed",
            summary: "changed category from Web to Frontend",
            metadata: {
              field: "category",
              from: "Web",
              to: "Frontend",
            },
          },
        ],
      });
    });

    it("does not record BugActivity when category name is not changed", async () => {
      findFirstMock
        .mockResolvedValueOnce({ id: "cat-1", name: "Web", tenantId: "tenant-ziki" })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "cat-1", name: "Web", tenantId: "tenant-ziki" });
      updateMock.mockResolvedValue({ id: "cat-1", name: "Web" });

      const formData = new FormData();
      formData.set("name", "Web");

      const result = await updateCategoryAction("cat-1", formData);

      expect(result.ok).toBe(true);
      expect(bugActivityCreateManyMock).not.toHaveBeenCalled();
    });
  });
});
