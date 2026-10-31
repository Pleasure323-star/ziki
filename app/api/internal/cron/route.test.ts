import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockRunPlatformSweeps = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron/runner", () => ({
  runPlatformSweeps: mockRunPlatformSweeps,
}));

import { GET, POST } from "./route";

const makeRequest = (method: "GET" | "POST", secret?: string) =>
  new NextRequest("http://localhost/api/internal/cron", {
    method,
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });

describe("app/api/internal/cron/route (#647)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it("fails with 503 if CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = await GET(makeRequest("GET", "any-secret"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(mockRunPlatformSweeps).not.toHaveBeenCalled();
  });

  it("fails with 401 if authorization is missing or invalid", async () => {
    vi.stubEnv("CRON_SECRET", "super-cron-secret-123");

    // Missing
    const res1 = await GET(makeRequest("GET"));
    expect(res1.status).toBe(401);

    // Wrong secret
    const res2 = await POST(makeRequest("POST", "wrong-secret"));
    expect(res2.status).toBe(401);

    expect(mockRunPlatformSweeps).not.toHaveBeenCalled();
  });

  it("executes sweeps on authorized GET (Vercel Cron)", async () => {
    vi.stubEnv("CRON_SECRET", "super-cron-secret-123");
    mockRunPlatformSweeps.mockResolvedValueOnce({
      timestamp: "2026-10-20T19:00:00.000Z",
      sweeps: {
        offers: { status: "ok", expired: 1 },
        jobReviewOffers: { status: "ok", expired: 0, offered: 0 },
        claims: { status: "ok", released: 0, offered: 0 },
        promotions: { status: "ok", promoted: 0, demoted: 0 },
        deliveries: { status: "ok", processed: 2 },
        retention: { status: "ok", pruned: { pairings: 0, deliveries: 0, events: 0, auditEvents: 0, rateLimitHits: 0, unlinkedUploads: 0, deletedParentAttachments: 0 } },
      },
    });

    const res = await GET(makeRequest("GET", "super-cron-secret-123"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const json = await res.json();
    expect(json.sweeps.offers.expired).toBe(1);
    expect(json.sweeps.deliveries.processed).toBe(2);
    expect(mockRunPlatformSweeps).toHaveBeenCalledTimes(1);
  });

  it("executes sweeps on authorized POST (external scheduler)", async () => {
    vi.stubEnv("CRON_SECRET", "super-cron-secret-123");
    mockRunPlatformSweeps.mockResolvedValueOnce({
      timestamp: "2026-10-20T19:00:00.000Z",
      sweeps: {
        offers: { status: "ok", expired: 0 },
        jobReviewOffers: { status: "ok", expired: 0, offered: 0 },
        claims: { status: "ok", released: 1, offered: 1 },
        promotions: { status: "ok", promoted: 1, demoted: 0 },
        deliveries: { status: "ok", processed: 0 },
        retention: { status: "ok", pruned: { pairings: 0, deliveries: 0, events: 0, auditEvents: 0, rateLimitHits: 0, unlinkedUploads: 0, deletedParentAttachments: 0 } },
      },
    });

    const res = await POST(makeRequest("POST", "super-cron-secret-123"));
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.sweeps.claims.released).toBe(1);
    expect(json.sweeps.promotions.promoted).toBe(1);
    expect(mockRunPlatformSweeps).toHaveBeenCalledTimes(1);
  });

  it("handles unexpected sweep failures with a 500 error", async () => {
    vi.stubEnv("CRON_SECRET", "super-cron-secret-123");
    mockRunPlatformSweeps.mockRejectedValueOnce(new Error("Fatal database crash"));

    const res = await GET(makeRequest("GET", "super-cron-secret-123"));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toEqual(expect.any(String));
    expect(json.details).toBe("Fatal database crash");
  });
});
