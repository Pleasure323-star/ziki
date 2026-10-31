import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  agentApiKey: { findUnique: vi.fn() },
  agentAuditEvent: { create: vi.fn() },
  attachment: { create: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
}));
const budget = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agents/rate-budget", async (original) => ({
  ...(await original<typeof import("@/lib/agents/rate-budget")>()),
  consumeAgentBudget: budget,
}));

import { POST } from "./route";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function key(level = "working") {
  return {
    id: "key-a", revokedAt: null,
    agent: {
      id: "agent-a", name: "Ada's Claude", ownerUserId: "ada", tenantId: "tenant-a", level, burst: false, revokedAt: null,
      owner: { memberships: [{ tenantId: "tenant-a" }] },
    },
  };
}

function upload(file: File | null, { keyed = true, length }: { keyed?: boolean; length?: number } = {}) {
  const form = new FormData();
  if (file) form.append("file", file);
  const headers: Record<string, string> = keyed ? { authorization: "Bearer ziki_test-key" } : {};
  const req = new NextRequest("http://localhost/api/v1/attachments", { method: "POST", body: form, headers });
  if (length !== undefined) req.headers.set("content-length", String(length));
  return req;
}

/** A chunked body (no Content-Length) that records how much of it was pulled. */
function chunkedUpload(totalBytes: number, chunkSize = 512 * 1024) {
  let sent = 0;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size));
    },
  });
  const init = {
    method: "POST",
    body: stream,
    headers: {
      authorization: "Bearer ziki_test-key",
      "content-type": "multipart/form-data; boundary=test",
    },
    duplex: "half",
  } as unknown as ConstructorParameters<typeof NextRequest>[1];
  return { request: new NextRequest("http://localhost/api/v1/attachments", init), pulls: () => pulls };
}

beforeEach(() => {
  vi.resetAllMocks();
  db.agentApiKey.findUnique.mockResolvedValue(key());
  budget.mockResolvedValue({ allowed: true });
  db.attachment.create.mockImplementation(async ({ data }: { data: { filename: string; contentType: string; size: number } }) => ({
    id: "att-1", filename: data.filename, contentType: data.contentType, size: data.size,
  }));
  db.attachment.deleteMany.mockResolvedValue({ count: 0 });
  db.attachment.findMany.mockResolvedValue([]);
});

describe("POST /api/v1/attachments (#645)", () => {
  it("stores a screenshot unlinked, owned by the agent's owner, and charges a write", async () => {
    const response = await POST(upload(new File([PNG], "safari-bug.png", { type: "image/png" })));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: "att-1", contentType: "image/png", filename: "safari-bug.png" });
    expect(db.attachment.create.mock.calls[0][0].data).toMatchObject({ uploaderId: "ada", contentType: "image/png" });
    expect(db.attachment.create.mock.calls[0][0].data).not.toHaveProperty("bugId");
    expect(budget).toHaveBeenCalledWith({ id: "agent-a", burst: false, burstUntil: null }, "write");
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "attachments.upload" }) });
    // The #543 sweep runs for the owner after a successful upload.
    expect(db.attachment.deleteMany).toHaveBeenCalledWith({ where: expect.objectContaining({ uploaderId: "ada", bugId: null }) });
  });

  it("refuses SVG and HTML whatever they're called", async () => {
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], "shot.png", { type: "image/png" });
    expect((await POST(upload(svg))).status).toBe(415);
    const html = new File(["<!doctype html><script>x</script>"], "report.html", { type: "text/html" });
    expect((await POST(upload(html))).status).toBe(415);
    expect(db.attachment.create).not.toHaveBeenCalled();
  });

  it("refuses an oversized body before reading it", async () => {
    const response = await POST(upload(new File([PNG], "big.png"), { length: 40 * 1024 * 1024 }));
    expect(response.status).toBe(413);
    expect(db.attachment.create).not.toHaveBeenCalled();
  });

  it("stops a chunked body over the cap instead of buffering all of it (#485)", async () => {
    const { request, pulls } = chunkedUpload(8 * 1024 * 1024);

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    // 8 MB in 512 KB chunks is 16 pulls; reading stopped near the 5 MB cap.
    expect(pulls()).toBeLessThan(16);
    expect(db.attachment.create).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric content-length instead of treating it as zero (#485)", async () => {
    const request = upload(new File([PNG], "shot.png", { type: "image/png" }));
    request.headers.set("content-length", "12abc");

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(db.attachment.create).not.toHaveBeenCalled();
  });

  it("refuses a file over 5 MB that slipped past the length check", async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 10);
    big.set(PNG);
    expect((await POST(upload(new File([big], "big.png")))).status).toBe(413);
  });

  it("needs an agent key, and a file", async () => {
    expect((await POST(upload(new File([PNG], "a.png"), { keyed: false }))).status).toBe(401);
    expect((await POST(upload(null))).status).toBe(400);
    expect(db.attachment.create).not.toHaveBeenCalled();
  });
});
