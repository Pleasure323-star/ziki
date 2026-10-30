import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";
import {
  AGENT_RATE_BUDGETS,
  agentBudget,
  agentBudgetExceededResponse,
  agentBudgetKey,
  burstActive,
  consumeAgentBudget,
  withAgentBudgetHeaders,
} from "./rate-budget";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const standard = { id: "agent-standard", burst: false };
const burst = { id: "agent-burst", burst: true };

async function spend(agent: { id: string; burst: boolean }, kind: "read" | "write" | "heartbeat", times: number, now: number) {
  for (let i = 0; i < times; i++) {
    const result = await consumeAgentBudget(agent, kind, now + i);
    if (!result.allowed) throw new Error(`rejected at request ${i + 1}`);
  }
}

describe("agent rate budgets (#440)", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("uses agent:{id}:read, agent:{id}:write and agent:{id}:heartbeat keys", () => {
    expect(agentBudgetKey("a1", "read")).toBe("agent:a1:read");
    expect(agentBudgetKey("a1", "write")).toBe("agent:a1:write");
    expect(agentBudgetKey("a1", "heartbeat")).toBe("agent:a1:heartbeat");
  });

  it("matches the budgets in the issue", () => {
    expect(AGENT_RATE_BUDGETS.standard.write).toEqual({ max: 60, windowMs: MINUTE });
    expect(AGENT_RATE_BUDGETS.standard.read).toEqual({ max: 600, windowMs: HOUR });
    expect(AGENT_RATE_BUDGETS.standard.heartbeat).toEqual({ max: 120, windowMs: HOUR });
    expect(AGENT_RATE_BUDGETS.burst.write).toEqual({ max: 60, windowMs: MINUTE });
    expect(AGENT_RATE_BUDGETS.burst.read).toEqual({ max: 4000, windowMs: HOUR });
    expect(AGENT_RATE_BUDGETS.burst.heartbeat).toEqual({ max: 120, windowMs: HOUR });
  });

  it("heartbeat (#556) has its own counter: exhausting writes doesn't block it, and it has its own cap", async () => {
    await spend(standard, "write", 60, 0);
    expect((await consumeAgentBudget(standard, "write", 100)).allowed).toBe(false);
    // A write-exhausted agent can still heartbeat its active claims.
    expect((await consumeAgentBudget(standard, "heartbeat", 100)).allowed).toBe(true);
    // That was the 1st of 120; 119 more exactly exhausts the heartbeat cap.
    await spend(standard, "heartbeat", 119, 101);
    expect((await consumeAgentBudget(standard, "heartbeat", 200)).allowed).toBe(false);
    // Spending the heartbeat budget doesn't touch write or read either.
    expect((await consumeAgentBudget(standard, "read", 202)).allowed).toBe(true);
  });

  it("has no hourly write cap (#699): 1000 writes spread over an hour all pass", async () => {
    for (let i = 0; i < 1000; i++) {
      const result = await consumeAgentBudget(standard, "write", i * 3_600);
      if (!result.allowed) throw new Error(`rejected at write ${i + 1}`);
    }
  });

  it("stops a runaway loop at the 61st write within a minute", async () => {
    await spend(standard, "write", 60, 0);
    expect((await consumeAgentBudget(standard, "write", 1000)).allowed).toBe(false);
  });

  it("treats a missing burst flag as standard", async () => {
    const agent = { id: "agent-no-flag" };
    for (let i = 0; i < 600; i++) await consumeAgentBudget(agent, "read", i);
    expect((await consumeAgentBudget(agent, "read", 1000)).allowed).toBe(false);
  });

  it("gives a burst key the same write guard as everyone", async () => {
    await spend(burst, "write", 60, 0);
    expect((await consumeAgentBudget(burst, "write", 1000)).allowed).toBe(false);
  });

  it("does not share a counter between reads and writes", async () => {
    await spend(standard, "write", 60, 0);
    expect((await consumeAgentBudget(standard, "write", 100)).allowed).toBe(false);
    expect((await consumeAgentBudget(standard, "read", 100)).allowed).toBe(true);
  });

  it("does not share a counter between agents", async () => {
    await spend(standard, "write", 60, 0);
    expect((await consumeAgentBudget({ id: "other", burst: false }, "write", 100)).allowed).toBe(true);
  });

  it("rejects the 601st read for a standard key", async () => {
    await spend(standard, "read", 600, 0);
    expect((await consumeAgentBudget(standard, "read", 1000)).allowed).toBe(false);
  });

  it("allows writes again once the minute has passed", async () => {
    await spend(standard, "write", 60, 0);
    expect((await consumeAgentBudget(standard, "write", MINUTE + 60)).allowed).toBe(true);
  });

  it("says how long to wait, in whole seconds", async () => {
    await spend(standard, "write", 60, 0);
    const result = await consumeAgentBudget(standard, "write", MINUTE - 1500);
    expect(result).toMatchObject({ allowed: false, retryAfterSeconds: 2 });
  });

  it("responds 429 with Retry-After", async () => {
    const response = agentBudgetExceededResponse(42);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("too fast"), resetSeconds: 42 });
  });
});

describe("high-volume expiry (#596)", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("is active before the expiry and inactive at or after it", () => {
    const agent = { burst: true, burstUntil: new Date(1_000) };
    expect(burstActive(agent, 999)).toBe(true);
    expect(burstActive(agent, 1_000)).toBe(false);
    expect(burstActive(agent, 1_001)).toBe(false);
  });

  it("treats a null expiry as open-ended and a false flag as off", () => {
    expect(burstActive({ burst: true, burstUntil: null }, 10)).toBe(true);
    expect(burstActive({ burst: true }, 10)).toBe(true);
    expect(burstActive({ burst: false, burstUntil: new Date(10_000) }, 10)).toBe(false);
  });

  it("falls back to standard for a malformed expiry", () => {
    expect(burstActive({ burst: true, burstUntil: "not-a-date" }, 10)).toBe(false);
    expect(agentBudget({ id: "a", burst: true, burstUntil: "not-a-date" }, "read", 10)).toEqual({
      max: 600,
      windowMs: HOUR,
    });
  });

  it("uses the burst budget for an unexpired grant", async () => {
    const agent = { id: "agent-future", burst: true, burstUntil: new Date(HOUR * 2) };
    expect(await consumeAgentBudget(agent, "read", 0)).toMatchObject({
      allowed: true,
      limit: 4000,
      remaining: 3999,
    });
    await spend(agent, "read", 799, 1);
    expect((await consumeAgentBudget(agent, "read", 1_000)).allowed).toBe(true);
  });

  it("uses the standard budget as soon as the grant expires", async () => {
    const expiresAt = 1_000;
    const agent = { id: "agent-expiring", burst: true, burstUntil: new Date(expiresAt) };
    await spend(agent, "read", 700, 0);
    const afterExpiry = await consumeAgentBudget(agent, "read", expiresAt);
    expect(afterExpiry).toMatchObject({ allowed: false, limit: 600, remaining: 0 });
    expect((await consumeAgentBudget(agent, "read", expiresAt + 1)).allowed).toBe(false);
  });

  it("keeps an indefinite grant on until it is disabled", async () => {
    const agent = { id: "agent-indefinite", burst: true, burstUntil: null };
    expect(await consumeAgentBudget(agent, "read", 0)).toMatchObject({ limit: 4000 });
    expect(await consumeAgentBudget(agent, "read", 10 * HOUR)).toMatchObject({ limit: 4000 });
    expect(await consumeAgentBudget({ ...agent, burst: false }, "read", 10 * HOUR)).toMatchObject({ limit: 600 });
  });
});

describe("agent rate-limit quota headers (#646)", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("reports the budget, what's left and when it resets on every charge", async () => {
    const first = await consumeAgentBudget(standard, "write", 0);
    expect(first).toMatchObject({ allowed: true, kind: "write", limit: 60, windowSeconds: 60, remaining: 59, resetSeconds: 60 });
    await spend(standard, "write", 9, 1000);
    const tenth = await consumeAgentBudget(standard, "write", 20 * 1000);
    // The first charge leaves the window at 60 s, 40 seconds on.
    expect(tenth).toMatchObject({ remaining: 49, resetSeconds: 40 });
  });

  it("keeps reads and writes apart", async () => {
    await spend(standard, "write", 5, 0);
    expect(await consumeAgentBudget(standard, "read", 10)).toMatchObject({ kind: "read", limit: 600, remaining: 599 });
  });

  it("uses the burst limits for a burst agent", async () => {
    expect(await consumeAgentBudget(burst, "read", 0)).toMatchObject({ limit: 4000, remaining: 3999 });
  });

  it("names the exhausted budget and when it resets in a 429", async () => {
    await spend(standard, "write", 60, 0);
    const result = await consumeAgentBudget(standard, "write", MINUTE - 1500);
    if (result.allowed) throw new Error("expected a refusal");
    const response = agentBudgetExceededResponse(result.retryAfterSeconds, result);
    expect(response.status).toBe(429);
    expect(Object.fromEntries(["Retry-After", "RateLimit-Budget", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "RateLimit-Policy"].map((h) => [h, response.headers.get(h)]))).toEqual({
      "Retry-After": "2",
      "RateLimit-Budget": "write",
      "RateLimit-Limit": "60",
      "RateLimit-Remaining": "0",
      "RateLimit-Reset": "2",
      "RateLimit-Policy": "60;w=60",
    });
    expect(await response.json()).toMatchObject({ budget: "write", limit: 60, resetSeconds: 2 });
  });

  it("adds headers to a successful response without inventing fields it doesn't know", async () => {
    const ok = withAgentBudgetHeaders(new Response("{}"), { kind: "read", limit: 600, windowSeconds: 3600, remaining: 12, resetSeconds: 90 });
    expect(ok.headers.get("RateLimit-Remaining")).toBe("12");
    expect(ok.headers.get("RateLimit-Reset")).toBe("90");
    expect(ok.headers.get("RateLimit-Limit")).toBe("600");
    expect(ok.headers.get("X-RateLimit-Limit")).toBeNull();
    const bare = withAgentBudgetHeaders(new Response("{}"), {});
    expect([...bare.headers.keys()].filter((h) => h.startsWith("ratelimit") || h.startsWith("x-ratelimit"))).toEqual([]);
  });
});
