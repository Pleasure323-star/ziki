import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

const { pointEntry, db } = vi.hoisted(() => {
  const pointEntry = {
    update: vi.fn(),
    createMany: vi.fn(),
  };
  const db = { pointEntry } as unknown as PrismaClient;
  return { pointEntry, db };
});

vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { correct, correctionSourceKey } from "./correct";

beforeEach(() => {
  vi.clearAllMocks();
  pointEntry.update.mockResolvedValue({ count: 1 });
  pointEntry.createMany.mockResolvedValue({ count: 1 });
});

describe("correct (#450)", () => {
  it("stamps correctedAt on the original entry and writes one reversing entry", async () => {
    const entry = {
      id: "entry-1",
      tenantId: "tenant-zedu",
      userId: "user-1",
      bugId: "bug-1",
      role: "reporter" as const,
      points: 5,
    };

    const { awarded } = await correct(db, { entry });

    expect(pointEntry.update).toHaveBeenCalledWith({
      where: { id: "entry-1" },
      data: { correctedAt: expect.any(Date) },
    });
    expect(pointEntry.createMany).toHaveBeenCalledWith({
      data: [
        {
          tenantId: "tenant-zedu",
          userId: "user-1",
          bugId: "bug-1",
          role: "reporter",
          points: -5,
          sourceKey: "undo:entry-1",
          agentId: null,
        },
      ],
      skipDuplicates: true,
    });
    expect(awarded).toBe(true);
  });

  it("derives the correction source key as undo:{entryId}", () => {
    expect(correctionSourceKey("entry-1")).toBe("undo:entry-1");
  });

  it("uses the same idempotency key on a second undo", async () => {
    const entry = {
      id: "entry-1",
      tenantId: "tenant-zedu",
      userId: "user-1",
      bugId: null,
      role: "solver" as const,
      points: 25,
    };

    await correct(db, { entry });
    await correct(db, { entry });

    expect(pointEntry.createMany).toHaveBeenCalledTimes(2);
    expect(pointEntry.createMany.mock.calls[1][0].data[0].sourceKey).toBe(
      "undo:entry-1",
    );
  });
});
