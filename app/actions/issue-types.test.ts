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
  requireAdmin: vi.fn().mockResolvedValue({ id: "admin-1", role: "admin" }),
}));

vi.mock("@/lib/tenant-context", () => ({
  currentTenantIdFor: vi.fn().mockResolvedValue("tenant-ziki"),
}));

vi.mock("@/lib/prisma", () => {
  const db = {
    issueType: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    tenant: {
      findUnique: vi.fn().mockResolvedValue({ id: "tenant-ziki", name: "Ziki" }),
    },
    membership: {
      findUnique: vi.fn().mockResolvedValue({ role: "member" }),
    },
    bug: {
      count: vi.fn(),
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
import {
  createIssueTypeAction,
  deleteIssueTypeAction,
  updateIssueTypeAction,
} from "./issue-types";

const findFirstMock = vi.mocked(prisma.issueType.findFirst) as unknown as ReturnType<typeof vi.fn>;
const createMock = vi.mocked(prisma.issueType.create) as unknown as ReturnType<typeof vi.fn>;
const updateMock = vi.mocked(prisma.issueType.update) as unknown as ReturnType<typeof vi.fn>;
const deleteMock = vi.mocked(prisma.issueType.delete) as unknown as ReturnType<typeof vi.fn>;
const bugCountMock = vi.mocked(prisma.bug.count) as unknown as ReturnType<typeof vi.fn>;
const bugFindManyMock = vi.mocked(prisma.bug.findMany) as unknown as ReturnType<typeof vi.fn>;
const bugActivityCreateManyMock = vi.mocked(prisma.bugActivity.createMany) as unknown as ReturnType<typeof vi.fn>;

/** The error Prisma throws when the row to update/delete no longer exists. */
const recordNotFound = Object.assign(new Error("Record to delete does not exist."), {
  code: "P2025",
});

describe("issue-types actions duplicate checks (#139)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createIssueTypeAction", () => {
    it("rejects case-insensitive duplicate type names", async () => {
      findFirstMock.mockResolvedValue({ id: "type-1", name: "Fix" });

      const formData = new FormData();
      formData.set("name", "fix ");

      const result = await createIssueTypeAction(formData);

      expect(result.error).toBe('A type named "Fix" already exists.');
      expect(findFirstMock).toHaveBeenCalledWith({
        where: {
          tenantId: "tenant-ziki",
          name: {
            equals: "fix",
            mode: "insensitive",
          },
        },
      });
      expect(createMock).not.toHaveBeenCalled();
    });

    it("creates type when name is unique", async () => {
      findFirstMock.mockResolvedValue(null);
      createMock.mockResolvedValue({ id: "type-2", name: "Feat", isActive: true });

      const formData = new FormData();
      formData.set("name", "  Feat  ");

      const result = await createIssueTypeAction(formData);

      expect(result.ok).toBe(true);
      expect(createMock).toHaveBeenCalledWith({
        data: {
          tenantId: "tenant-ziki",
          name: "Feat",
          description: null,
          template: null,
          isActive: true,
        },
      });
    });
  });

  describe("updateIssueTypeAction", () => {
    it("rejects case-insensitive duplicate when updating to an existing type name", async () => {
      findFirstMock.mockImplementation(async ({ where }) => {
        if (where.id) return { id: "type-2", name: "Feature" };
        return { id: "type-1", name: "Design" };
      });

      const formData = new FormData();
      formData.set("name", "DESIGN");

      const result = await updateIssueTypeAction("type-2", formData);

      expect(result.error).toBe('Another type named "Design" already exists.');
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("records BugActivity on linked issues when issue type name is renamed (#365)", async () => {
      findFirstMock.mockImplementation(async ({ where }) => {
        if (where.id) return { id: "type-1", name: "Bug" };
        return null;
      });
      updateMock.mockResolvedValue({ id: "type-1", name: "Defect" });
      bugFindManyMock.mockResolvedValue([{ id: "bug-1" }, { id: "bug-2" }]);
      bugActivityCreateManyMock.mockResolvedValue({ count: 2 });

      const formData = new FormData();
      formData.set("name", "Defect");

      const result = await updateIssueTypeAction("type-1", formData);

      expect(result.ok).toBe(true);
      expect(updateMock).toHaveBeenCalledWith({
        where: { id: "type-1" },
        data: {
          name: "Defect",
          description: null,
          isActive: true,
        },
      });
      expect(bugActivityCreateManyMock).toHaveBeenCalledWith({
        data: [
          {
            bugId: "bug-1",
            actorId: "admin-1",
            type: "type_changed",
            summary: "changed type from Bug to Defect",
            metadata: {
              field: "type",
              from: "Bug",
              to: "Defect",
            },
          },
          {
            bugId: "bug-2",
            actorId: "admin-1",
            type: "type_changed",
            summary: "changed type from Bug to Defect",
            metadata: {
              field: "type",
              from: "Bug",
              to: "Defect",
            },
          },
        ],
      });
    });

    it("does not record BugActivity when issue type name is unchanged", async () => {
      findFirstMock.mockImplementation(async ({ where }) => {
        if (where.id) return { id: "type-1", name: "Bug" };
        return null;
      });
      updateMock.mockResolvedValue({ id: "type-1", name: "Bug" });

      const formData = new FormData();
      formData.set("name", "Bug");

      const result = await updateIssueTypeAction("type-1", formData);

      expect(result.ok).toBe(true);
      expect(bugActivityCreateManyMock).not.toHaveBeenCalled();
    });
  });
});

describe("issue-types actions on a type that no longer exists (#227)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 'Type not found' when updating a type deleted in another tab", async () => {
    findFirstMock.mockResolvedValue(null);
    updateMock.mockRejectedValue(recordNotFound);

    const formData = new FormData();
    formData.set("name", "Design");

    const result = await updateIssueTypeAction("type-gone", formData);

    expect(result).toEqual({ error: expect.any(String) });
  });

  it("returns 'Type not found' when deleting a type that is already gone", async () => {
    findFirstMock.mockResolvedValue(null);

    const result = await deleteIssueTypeAction("type-gone");

    expect(result).toEqual({ error: expect.any(String) });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("returns 'Type not found' when the type is deleted between the check and the delete", async () => {
    findFirstMock.mockResolvedValue({ id: "type-1" });
    bugCountMock.mockResolvedValue(0);
    deleteMock.mockRejectedValue(recordNotFound);

    const result = await deleteIssueTypeAction("type-1");

    expect(result).toEqual({ error: expect.any(String) });
  });

  it("still deletes an unused type that exists", async () => {
    findFirstMock.mockResolvedValue({ id: "type-1" });
    bugCountMock.mockResolvedValue(0);
    deleteMock.mockResolvedValue({ id: "type-1" });

    const result = await deleteIssueTypeAction("type-1");

    expect(result).toEqual({ ok: true });
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: "type-1" } });
  });
});

describe("issue type templates (#307)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findFirstMock.mockResolvedValue(null);
  });

  it("stores a template on create, normalised", async () => {
    createMock.mockResolvedValue({ id: "t" });
    const fd = new FormData();
    fd.set("name", "Docs");
    fd.set("template", "### Page\r\n\r\n### What's wrong\n\n\n");
    expect(await createIssueTypeAction(fd)).toEqual({ ok: true });
    expect(createMock.mock.calls[0][0].data.template).toBe("### Page\n\n### What's wrong\n");
  });

  it("stores a blank template as none", async () => {
    findFirstMock.mockImplementation(async ({ where }) => {
      if (where.id) return { id: "t", name: "Docs" };
      return null;
    });
    updateMock.mockResolvedValue({ id: "t" });
    const fd = new FormData();
    fd.set("name", "Docs");
    fd.set("template", "   \n ");
    await updateIssueTypeAction("t", fd);
    expect(updateMock.mock.calls[0][0].data.template).toBeNull();
  });

  it("leaves the template alone when an update doesn't send one", async () => {
    findFirstMock.mockImplementation(async ({ where }) => {
      if (where.id) return { id: "t", name: "Docs" };
      return null;
    });
    updateMock.mockResolvedValue({ id: "t" });
    const fd = new FormData();
    fd.set("name", "Docs");
    await updateIssueTypeAction("t", fd);
    expect(updateMock.mock.calls[0][0].data).not.toHaveProperty("template");
  });

  it("rejects a template over the limit", async () => {
    const fd = new FormData();
    fd.set("name", "Docs");
    fd.set("template", "x".repeat(5001));
    expect((await createIssueTypeAction(fd)).error).toMatch(/5000 characters/);
    expect(createMock).not.toHaveBeenCalled();
  });
});
