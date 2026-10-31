import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.hoisted(() => vi.fn());
const currentTenantIdFor = vi.hoisted(() => vi.fn());
const feedProject = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth-helpers", () => ({ requireUser }));
vi.mock("@/lib/tenant-context", () => ({ currentTenantIdFor }));
vi.mock("@/lib/feed", () => ({
  feedProject,
  feedWhere: vi.fn(() => ({})),
  FEED_PAGE_SIZE: 50,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    bug: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import FeedPage from "./page";

describe("FeedPage (#542)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "user-1", name: "Ada Lovelace" });
    currentTenantIdFor.mockResolvedValue("tenant-1");
    feedProject.mockResolvedValue({ id: "proj-1", name: "Ziki Web" });
  });

  it("renders LocalTime for issue timestamps instead of raw ISO string", async () => {
    const createdAt = new Date("2026-10-19T19:56:32.534Z");
    vi.mocked(prisma.bug.findMany).mockResolvedValueOnce([
      {
        id: "bug-1",
        number: 42,
        title: "Test bug",
        status: "open",
        createdAt,
        project: { slug: "ziki" },
      },
    ] as unknown as Awaited<ReturnType<typeof prisma.bug.findMany>>);

    const element = await FeedPage({
      searchParams: Promise.resolve({ projectId: "proj-1" }),
    });

    expect(element).toBeDefined();

    // Verify element tree renders LocalTime component with the date prop
    function hasLocalTime(node: unknown): boolean {
      if (!node || typeof node !== "object") return false;
      const anyNode = node as { type?: unknown; props?: { date?: Date; children?: unknown } };
      if (anyNode.props?.date?.getTime?.() === createdAt.getTime()) return true;
      if (Array.isArray(anyNode.props?.children)) {
        return anyNode.props.children.some(hasLocalTime);
      }
      return hasLocalTime(anyNode.props?.children);
    }

    expect(hasLocalTime(element)).toBe(true);
  });
});
