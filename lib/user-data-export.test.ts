import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportUserData } from "./user-data-export";

describe("exportUserData (#571)", () => {
  const mockDb = {
    user: {
      findUnique: vi.fn(),
    },
    bug: {
      findMany: vi.fn(),
    },
    comment: {
      findMany: vi.fn(),
    },
    vote: {
      findMany: vi.fn(),
    },
    pointEntry: {
      findMany: vi.fn(),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws an error if user does not exist", async () => {
    mockDb.user.findUnique.mockResolvedValue(null);

    await expect(exportUserData(mockDb as never, "user-404")).rejects.toThrow(
      'User with ID "user-404" not found.',
    );
  });

  it("returns user data including issues, comments, votes, and points", async () => {
    const user = {
      id: "user-1",
      name: "Alice Contributor",
      email: "alice@example.com",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      walletAddress: "0x1234567890123456789012345678901234567890",
    };
    const issues = [
      {
        id: "bug-1",
        number: 42,
        title: "Test issue",
        description: "Steps to reproduce",
        status: "open",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        tenantId: "tenant-zedu",
        projectId: "proj-1",
      },
    ];
    const comments = [
      {
        id: "com-1",
        bugId: "bug-1",
        body: "I noticed this too",
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
        editedAt: null,
        deletedAt: null,
      },
    ];
    const votes = [
      {
        id: "vote-1",
        bugId: "bug-1",
        value: 1,
        createdAt: new Date("2026-01-04T00:00:00.000Z"),
      },
    ];
    const points = [
      {
        id: "pt-1",
        tenantId: "tenant-zedu",
        bugId: "bug-1",
        role: "reporter",
        points: 50,
        sourceKey: "key-1",
        correctedAt: null,
        createdAt: new Date("2026-01-05T00:00:00.000Z"),
      },
    ];

    mockDb.user.findUnique.mockResolvedValue(user);
    mockDb.bug.findMany.mockResolvedValue(issues);
    mockDb.comment.findMany.mockResolvedValue(comments);
    mockDb.vote.findMany.mockResolvedValue(votes);
    mockDb.pointEntry.findMany.mockResolvedValue(points);

    const result = await exportUserData(mockDb as never, "user-1");

    expect(result.user).toEqual(user);
    expect(result.issues).toEqual(issues);
    expect(result.comments).toEqual(comments);
    expect(result.votes).toEqual(votes);
    expect(result.points).toEqual(points);
    expect(typeof result.exportedAt).toBe("string");
    expect(mockDb.bug.findMany).toHaveBeenCalledWith({
      where: { reporterId: "user-1" },
      select: expect.any(Object),
      orderBy: { createdAt: "desc" },
    });
    expect(mockDb.comment.findMany).toHaveBeenCalledWith({
      where: { authorId: "user-1" },
      select: expect.any(Object),
      orderBy: { createdAt: "desc" },
    });
    expect(mockDb.vote.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      select: expect.any(Object),
      orderBy: { createdAt: "desc" },
    });
    expect(mockDb.pointEntry.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      select: expect.any(Object),
      orderBy: { createdAt: "desc" },
    });
  });
});
