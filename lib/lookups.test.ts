import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ update: [] as string[], revalidate: [] as unknown[][] }));
vi.mock("next/cache", () => ({
  // Pass-through: these tests are about what's read and what's expired,
  // not about Next's cache itself.
  unstable_cache: (fn: (...a: unknown[]) => unknown) => fn,
  updateTag: (tag: string) => {
    if (tag.startsWith("outside-action")) throw new Error("not in a server action");
    calls.update.push(tag);
  },
  revalidateTag: (...args: unknown[]) => calls.revalidate.push(args),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    category: { findMany: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
    issueType: { findMany: vi.fn() },
    notification: { count: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import {
  TAGS,
  expireTag,
  expireUnreadCounts,
  getActivePlatforms,
  getIssueTypes,
  getPlatforms,
  platformsNeedRepair,
} from "./lookups";

const findPlatforms = prisma.category.findMany as unknown as ReturnType<typeof vi.fn>;
const findIssueTypes = prisma.issueType.findMany as unknown as ReturnType<typeof vi.fn>;
const upsert = prisma.category.upsert as unknown as ReturnType<typeof vi.fn>;

const healthy = [
  { id: "1", name: "Desktop", isActive: true },
  { id: "2", name: "Mobile", isActive: true },
  { id: "3", name: "Web", isActive: true },
  { id: "4", name: "Backend", isActive: false },
  { id: "5", name: "TV", isActive: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  calls.update.length = 0;
  calls.revalidate.length = 0;
});

describe("platformsNeedRepair", () => {
  it("is false for the normal state", () => {
    expect(platformsNeedRepair(healthy)).toBe(false);
  });
  it("is true when a default is missing or a retired one is active", () => {
    expect(platformsNeedRepair(healthy.filter((p) => p.name !== "Web"))).toBe(true);
    expect(platformsNeedRepair([...healthy.slice(0, 3), { id: "9", name: "FE", isActive: true }])).toBe(true);
    expect(platformsNeedRepair([])).toBe(true);
  });
});

describe("getPlatforms", () => {
  it("doesn't write when nothing needs repairing", async () => {
    findPlatforms.mockResolvedValue(healthy);
    expect(await getPlatforms("tenant-ziki")).toEqual(healthy);
    expect(upsert).not.toHaveBeenCalled();
    expect(findPlatforms).toHaveBeenCalledWith({
      where: { tenantId: "tenant-ziki" },
      select: { id: true, name: true, isActive: true },
      orderBy: { name: "asc" },
    });
  });

  it("returns nothing when no organization is open", async () => {
    expect(await getPlatforms(null)).toEqual([]);
    expect(findPlatforms).not.toHaveBeenCalled();
  });

  it("seeds and then reads fresh rows when defaults are missing", async () => {
    findPlatforms.mockResolvedValueOnce([]).mockResolvedValueOnce(healthy);
    expect(await getPlatforms("tenant-ziki")).toEqual(healthy);
    expect(upsert).toHaveBeenCalledTimes(3);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_name: { tenantId: "tenant-ziki", name: "Desktop" } },
        create: { tenantId: "tenant-ziki", name: "Desktop", isActive: true },
      }),
    );
    expect(findPlatforms).toHaveBeenCalledTimes(2);
  });

  it("getActivePlatforms returns only active ones, as {id, name}", async () => {
    findPlatforms.mockResolvedValue(healthy);
    expect(await getActivePlatforms("tenant-ziki")).toEqual([
      { id: "1", name: "Desktop" },
      { id: "2", name: "Mobile" },
      { id: "3", name: "Web" },
    ]);
  });
});

describe("getIssueTypes", () => {
  const rows = [{ id: "t1", name: "Fix", description: null, isActive: true }];

  it("reads templates with the types", async () => {
    findIssueTypes.mockResolvedValue(rows.map((row) => ({ ...row, template: "steps" })));
    await expect(getIssueTypes("tenant-ziki")).resolves.toEqual(rows.map((row) => ({ ...row, template: "steps" })));
    expect(findIssueTypes).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tenant-ziki" } }),
    );
    expect(findIssueTypes).toHaveBeenCalledTimes(1);
  });

  it("reads types without a template column when that migration has not run", async () => {
    findIssueTypes
      .mockRejectedValueOnce(new Error("The column `IssueType.template` does not exist in the current database."))
      .mockResolvedValueOnce(rows);
    await expect(getIssueTypes("tenant-ziki")).resolves.toEqual(rows.map((row) => ({ ...row, template: null })));
    expect(findIssueTypes).toHaveBeenLastCalledWith(
      expect.objectContaining({
        select: { id: true, name: true, description: true, isActive: true },
      }),
    );
  });

  it("does not hide an unrelated read failure", async () => {
    findIssueTypes.mockRejectedValue(new Error('column "voteCount" does not exist'));
    await expect(getIssueTypes("tenant-ziki")).rejects.toThrow(/voteCount/);
    expect(findIssueTypes).toHaveBeenCalledTimes(1);
  });

  it("treats a P2022 on template as a missing column, not a query that mentions it", async () => {
    findIssueTypes
      .mockRejectedValueOnce({ code: "P2022", meta: { column: "IssueType.template" } })
      .mockResolvedValueOnce(rows);
    await expect(getIssueTypes("tenant-ziki")).resolves.toEqual(rows.map((row) => ({ ...row, template: null })));
  });

  it("returns nothing when no organization is open", async () => {
    expect(await getIssueTypes(null)).toEqual([]);
    expect(findIssueTypes).not.toHaveBeenCalled();
  });
});

describe("expireTag", () => {
  it("uses updateTag inside a server action", () => {
    expireTag(TAGS.platforms);
    expect(calls.update).toEqual([TAGS.platforms]);
    expect(calls.revalidate).toEqual([]);
  });
  it("falls back to an immediate revalidateTag elsewhere", () => {
    expireTag("outside-action:x");
    expect(calls.revalidate).toEqual([["outside-action:x", { expire: 0 }]]);
  });
  it("expires each recipient's unread count once", () => {
    expireUnreadCounts(["a", "b", "a"]);
    expect(calls.update).toEqual([TAGS.unread("a"), TAGS.unread("b")]);
  });
});

describe("every write path expires what it changes", () => {
  const src = (p: string) => readFileSync(p, "utf8");
  const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

  it("each platform and issue-type action expires its tag", () => {
    const categories = src("app/actions/categories.ts");
    const types = src("app/actions/issue-types.ts");
    expect(count(categories, /export async function \w+Action/g)).toBe(
      count(categories, /revalidatePlatforms\(\);/g),
    );
    expect(categories).toMatch(/function revalidatePlatforms\(\)[\s\S]*expireTag\(TAGS\.platforms\)/);
    expect(count(types, /export async function/g)).toBe(
      count(types, /expireTag\(TAGS\.issueTypes\)/g),
    );
  });

  it("creating or reading notifications expires the badge", () => {
    expect(src("lib/notify.ts")).toMatch(/expireUnreadCounts\(/);
    expect(src("app/actions/notifications.ts")).toMatch(/expireTag\(TAGS\.unread\(user\.id\)\)/);
    expect(src("app/(app)/notifications/[id]/route.ts")).toMatch(/expireTag\(TAGS\.unread\(/);
  });

  it("every file that writes notifications also expires a badge", () => {
    // A new "mark read" or "notify" path must expire the count too; this
    // fails loudly instead of the badge going quietly stale.
    const files = execSync("git ls-files app lib", { encoding: "utf8" })
      .split("\n")
      // A tracked file deleted in the working tree has nothing left to check.
      .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts") && f !== "lib/lookups.ts" && existsSync(f));
    const writers = files.filter((f) =>
      /prisma\.notification\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(/.test(src(f)),
    );
    expect(writers.length).toBeGreaterThanOrEqual(3);
    for (const file of writers) {
      expect([file, /expire(Tag|UnreadCounts)\(/.test(src(file))]).toEqual([file, true]);
    }
  });
});
