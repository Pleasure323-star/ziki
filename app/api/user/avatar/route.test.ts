import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const requireUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-helpers", () => ({ requireUser }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    attachment: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { GET, POST, DELETE } from "./route";

const findUnique = vi.mocked(prisma.user.findUnique) as unknown as ReturnType<typeof vi.fn>;
const update = vi.mocked(prisma.user.update) as unknown as ReturnType<typeof vi.fn>;
const attachmentCreate = vi.mocked(prisma.attachment.create) as unknown as ReturnType<typeof vi.fn>;
const attachmentDelete = vi.mocked(prisma.attachment.deleteMany) as unknown as ReturnType<typeof vi.fn>;

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: "user-123", name: "Ada Lovelace", role: "user" });
  update.mockResolvedValue({ id: "user-123" });
  attachmentCreate.mockResolvedValue({ id: "att-1" });
  attachmentDelete.mockResolvedValue({ count: 1 });
});

describe("GET /api/user/avatar", () => {
  it("returns 401 when unauthenticated", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(GET()).rejects.toThrow("NEXT_REDIRECT");
  });

  it("returns current user avatar image", async () => {
    findUnique.mockResolvedValue({ image: "https://example.com/avatar.png" });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ image: "https://example.com/avatar.png" });
  });

  it("returns null if no avatar is set", async () => {
    findUnique.mockResolvedValue({ image: null });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ image: null });
  });
});

describe("POST /api/user/avatar", () => {
  it("returns 400 when no file is uploaded", async () => {
    const formData = new FormData();
    const req = new NextRequest("http://localhost:3000/api/user/avatar", {
      method: "POST",
      body: formData,
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it("returns 400 when file is SVG or invalid format", async () => {
    const formData = new FormData();
    formData.append("avatar", new File(["<svg></svg>"], "test.svg", { type: "image/svg+xml" }));
    const req = new NextRequest("http://localhost:3000/api/user/avatar", {
      method: "POST",
      body: formData,
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it("returns 200 and updates avatar for valid PNG file", async () => {
    const formData = new FormData();
    formData.append("avatar", new File([pngBytes], "profile.png", { type: "image/png" }));
    const req = new NextRequest("http://localhost:3000/api/user/avatar", {
      method: "POST",
      body: formData,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.image).toContain("https://");
    expect(json.image).toContain("/api/users/user-123/avatar");

    expect(attachmentCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        uploaderId: "user-123",
        contentType: "image/png",
      }),
    }));

    expect(update).toHaveBeenCalledWith({
      where: { id: "user-123" },
      data: { image: expect.stringMatching(/^https:\/\/.+\/api\/users\/user-123\/avatar\?v=\d+/) },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/settings/profile");
  });
});

describe("DELETE /api/user/avatar", () => {
  it("returns 200 and resets avatar to null", async () => {
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, image: null });

    expect(attachmentDelete).toHaveBeenCalledWith({
      where: { uploaderId: "user-123", filename: { startsWith: "avatar" } },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "user-123" },
      data: { image: null },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/settings/profile");
  });
});
