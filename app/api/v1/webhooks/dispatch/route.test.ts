import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const dispatch = vi.hoisted(() => vi.fn());
const prune = vi.hoisted(() => vi.fn().mockResolvedValue(0));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchDueDeliveries: dispatch }));
vi.mock("@/lib/agent-retention", () => ({ pruneAgentRows: prune }));
import { GET, POST } from "./route";
import { resetRateLimits } from "@/lib/rate-limit";
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); resetRateLimits(); });
const request = (key?: string) => new NextRequest("http://localhost/api/v1/webhooks/dispatch", { method: "POST", headers: key ? { authorization: `Bearer ${key}` } : {} });
const cronRequest = (key?: string) => new NextRequest("http://localhost/api/v1/webhooks/dispatch", { method: "GET", headers: key ? { authorization: `Bearer ${key}` } : {} });
describe("scheduler authorization", () => {
  it("fails closed without configuration, with no key, and with an agent key", async () => {
    vi.stubEnv("WEBHOOK_DISPATCH_SECRET", "");
    expect((await POST(request())).status).toBe(503);
    vi.stubEnv("WEBHOOK_DISPATCH_SECRET", "scheduler-test-secret");
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request("ziki_agent-key"))).status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });
  it("dispatches with the scheduler secret and preserves failures for retry", async () => {
    vi.stubEnv("WEBHOOK_DISPATCH_SECRET", "scheduler-test-secret");
    dispatch.mockResolvedValueOnce(2);
    prune.mockResolvedValueOnce({ deliveries: 1, events: 0, pairings: 0, auditEvents: 0 });
    const response = await POST(request("scheduler-test-secret"));
    expect(await response.json()).toEqual({ processed: 2 });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(prune).toHaveBeenCalled();
    dispatch.mockRejectedValueOnce(new Error("DB"));
    expect((await POST(request("scheduler-test-secret"))).status).toBe(503);
  });
  it("sweeps retention after dispatch without failing the response when the sweep errors (#546)", async () => {
    vi.stubEnv("WEBHOOK_DISPATCH_SECRET", "scheduler-test-secret");
    dispatch.mockResolvedValueOnce(0);
    prune.mockRejectedValueOnce(new Error("DB"));
    const response = await POST(request("scheduler-test-secret"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ processed: 0 });
  });
});

describe("Vercel cron dispatch (#583)", () => {
  it("dispatches GETs authorized with CRON_SECRET", async () => {
    vi.stubEnv("CRON_SECRET", "cron-test-secret");
    dispatch.mockResolvedValueOnce(3);
    const response = await GET(cronRequest("cron-test-secret"));
    expect(await response.json()).toEqual({ processed: 3 });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("fails closed without CRON_SECRET, and rejects the scheduler secret", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(cronRequest("cron-test-secret"))).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "cron-test-secret");
    expect((await GET(cronRequest())).status).toBe(401);
    expect((await GET(cronRequest("scheduler-test-secret"))).status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("dispatch rate limit (#679)", () => {
  it("allows the default 12 runs a minute per caller, then answers 429 without dispatching", async () => {
    vi.stubEnv("WEBHOOK_DISPATCH_SECRET", "scheduler-test-secret");
    dispatch.mockResolvedValue(0);
    for (let run = 0; run < 12; run++) {
      expect((await POST(request("scheduler-test-secret"))).status).toBe(200);
    }
    const limited = await POST(request("scheduler-test-secret"));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(await limited.json()).toEqual({
      error: expect.any(String),
      retryAfterSeconds: expect.any(Number),
    });
    expect(dispatch).toHaveBeenCalledTimes(12);
  });

  it("counts the scheduler and Vercel Cron separately", async () => {
    vi.stubEnv("WEBHOOK_DISPATCH_SECRET", "scheduler-test-secret");
    vi.stubEnv("CRON_SECRET", "cron-test-secret");
    vi.stubEnv("WEBHOOK_DISPATCH_MAX_PER_MINUTE", "1");
    dispatch.mockResolvedValue(0);
    expect((await POST(request("scheduler-test-secret"))).status).toBe(200);
    expect((await POST(request("scheduler-test-secret"))).status).toBe(429);
    expect((await GET(cronRequest("cron-test-secret"))).status).toBe(200);
    expect((await GET(cronRequest("cron-test-secret"))).status).toBe(429);
  });

  it("doesn't let unauthorised calls use up the scheduler's runs", async () => {
    vi.stubEnv("WEBHOOK_DISPATCH_SECRET", "scheduler-test-secret");
    vi.stubEnv("WEBHOOK_DISPATCH_MAX_PER_MINUTE", "1");
    dispatch.mockResolvedValue(0);
    for (let i = 0; i < 5; i++) expect((await POST(request("wrong-secret"))).status).toBe(401);
    expect((await POST(request("scheduler-test-secret"))).status).toBe(200);
  });
});
