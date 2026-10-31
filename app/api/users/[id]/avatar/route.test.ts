import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    attachment: {
      findFirst: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import { GET } from "./route";

const findFirst = vi.mocked(prisma.attachment.findFirst) as unknown as ReturnType<typeof vi.fn>;

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/users/[id]/avatar", () => {
  it("returns 404 when user has no avatar attachment", async () => {
    findFirst.mockResolvedValue(null);
    const req = new NextRequest("http://localhost:3000/api/users/user-1/avatar");
    const res = await GET(req, { params: Promise.resolve({ id: "user-1" }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it("returns 200 with raw image bytes and nosniff header when avatar exists", async () => {
    findFirst.mockResolvedValue({
      contentType: "image/png",
      data: Buffer.from(pngBytes),
    });
    const req = new NextRequest("http://localhost:3000/api/users/user-1/avatar");
    const res = await GET(req, { params: Promise.resolve({ id: "user-1" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const arrayBuffer = await res.arrayBuffer();
    expect(new Uint8Array(arrayBuffer)).toEqual(pngBytes);
  });
});
