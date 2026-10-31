import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkRateLimit,
  resetRateLimits,
  ACTION_RATE_LIMITS,
} from "./rate-limit";

describe("rate-limiting (#130)", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("allows actions within the limit", () => {
    const config = { max: 3, windowMs: 1000 };
    expect(checkRateLimit("user-1", config, 100).allowed).toBe(true);
    expect(checkRateLimit("user-1", config, 200).allowed).toBe(true);
    expect(checkRateLimit("user-1", config, 300).allowed).toBe(true);
  });

  it("blocks actions exceeding the limit in the window", () => {
    const config = { max: 2, windowMs: 1000 };
    expect(checkRateLimit("user-1", config, 100).allowed).toBe(true);
    expect(checkRateLimit("user-1", config, 200).allowed).toBe(true);

    const blocked = checkRateLimit("user-1", config, 300);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("resets after the window expires", () => {
    const config = { max: 2, windowMs: 1000 };
    expect(checkRateLimit("user-1", config, 100).allowed).toBe(true);
    expect(checkRateLimit("user-1", config, 200).allowed).toBe(true);
    expect(checkRateLimit("user-1", config, 300).allowed).toBe(false);

    // After 1000ms window from first request
    expect(checkRateLimit("user-1", config, 1200).allowed).toBe(true);
  });

  it("tracks rate limits separately for different users", () => {
    const config = { max: 1, windowMs: 1000 };
    expect(checkRateLimit("user-1", config, 100).allowed).toBe(true);
    expect(checkRateLimit("user-1", config, 200).allowed).toBe(false);
    expect(checkRateLimit("user-2", config, 200).allowed).toBe(true);
  });
});

describe("auth rate limits (#207)", () => {
  beforeEach(() => resetRateLimits());

  it("limits per email across different IPs", async () => {
    const { checkAuthRateLimit, AUTH_RATE_LIMITS } = await import("./rate-limit");
    const max = AUTH_RATE_LIMITS.forgotPassword.email.max;
    for (let i = 0; i < max; i++) {
      expect(checkAuthRateLimit("forgotPassword", { email: "Bob@x.dev", ip: `10.0.0.${i}` }, 1000).allowed).toBe(true);
    }
    // Same address, new IP, different casing: still blocked.
    expect(checkAuthRateLimit("forgotPassword", { email: "bob@x.dev ", ip: "10.0.0.99" }, 1000).allowed).toBe(false);
  });

  it("limits per IP across different emails", async () => {
    const { checkAuthRateLimit, AUTH_RATE_LIMITS } = await import("./rate-limit");
    const max = AUTH_RATE_LIMITS.signup.ip.max;
    for (let i = 0; i < max; i++) {
      expect(checkAuthRateLimit("signup", { email: `u${i}@x.dev`, ip: "1.2.3.4" }, 1000).allowed).toBe(true);
    }
    const blocked = checkAuthRateLimit("signup", { email: "fresh@x.dev", ip: "1.2.3.4" }, 1000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("frees up again once the window has passed", async () => {
    const { checkAuthRateLimit, AUTH_RATE_LIMITS } = await import("./rate-limit");
    const { max, windowMs } = AUTH_RATE_LIMITS.login.email;
    for (let i = 0; i < max; i++) checkAuthRateLimit("login", { email: "a@x.dev" }, 0);
    expect(checkAuthRateLimit("login", { email: "a@x.dev" }, 1).allowed).toBe(false);
    expect(checkAuthRateLimit("login", { email: "a@x.dev" }, windowMs + 1).allowed).toBe(true);
  });

  it("reads the client IP from proxy headers and ignores junk", async () => {
    const { clientIpFrom } = await import("./rate-limit");
    expect(clientIpFrom(new Headers({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIpFrom(new Headers({ "x-real-ip": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientIpFrom(new Headers({ "x-forwarded-for": "<script>" }))).toBeNull();
    expect(clientIpFrom(new Headers())).toBeNull();
  });

  describe("trusted proxy hops (#507)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("takes the entry the trusted proxy appended, not the one the client sent", async () => {
      const { clientIpFrom } = await import("./rate-limit");
      // The client sent 1.2.3.4; Traefik appended the real address.
      const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" });
      expect(clientIpFrom(headers)).toBe("203.0.113.7");
    });

    it("rotating the left-most value always yields the same client", async () => {
      const { clientIpFrom } = await import("./rate-limit");
      const seen = new Set(
        Array.from({ length: 12 }, (_, i) =>
          clientIpFrom(new Headers({ "x-forwarded-for": `10.0.0.${i}, 198.51.100.9` })),
        ),
      );
      expect([...seen]).toEqual(["198.51.100.9"]);
    });

    it("honours TRUSTED_PROXY_HOPS=2 (CDN in front of the proxy)", async () => {
      vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
      const { clientIpFrom } = await import("./rate-limit");
      expect(clientIpFrom(new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.0.0.2" }))).toBe("203.0.113.7");
      // A shorter chain than configured: the left-most entry came from a trusted hop.
      expect(clientIpFrom(new Headers({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
    });

    it("trusts no forwarding header with TRUSTED_PROXY_HOPS=0", async () => {
      vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
      const { clientIpFrom } = await import("./rate-limit");
      expect(clientIpFrom(new Headers({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "203.0.113.7" }))).toBeNull();
    });

    it("reads only CLIENT_IP_HEADER when it is set", async () => {
      vi.stubEnv("CLIENT_IP_HEADER", "CF-Connecting-IP");
      const { clientIpFrom } = await import("./rate-limit");
      expect(
        clientIpFrom(new Headers({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4" })),
      ).toBe("203.0.113.7");
      expect(clientIpFrom(new Headers({ "x-forwarded-for": "1.2.3.4" }))).toBeNull();
    });

    it("falls back to the default for nonsense hop counts", async () => {
      const { trustedProxyHops } = await import("./rate-limit");
      vi.stubEnv("TRUSTED_PROXY_HOPS", "lots");
      expect(trustedProxyHops()).toBe(1);
      vi.stubEnv("TRUSTED_PROXY_HOPS", "-3");
      expect(trustedProxyHops()).toBe(1);
      vi.stubEnv("TRUSTED_PROXY_HOPS", "99");
      expect(trustedProxyHops()).toBe(10);
    });

    it("evaluates TRUSTED_PROXIES from right to left and stops at first untrusted IP (#675)", async () => {
      vi.stubEnv("TRUSTED_PROXIES", "10.0.0.1, 10.0.0.2, 192.168.1.0/24, loopback");
      const { clientIpFrom } = await import("./rate-limit");

      // Attacker tried spoofing 1.1.1.1, client was 203.0.113.50, then passed through trusted internal proxies
      const headers = new Headers({
        "x-forwarded-for": "1.1.1.1, 203.0.113.50, 192.168.1.5, 10.0.0.1",
      });
      expect(clientIpFrom(headers)).toBe("203.0.113.50");
    });

    it("returns null if all IPs in X-Forwarded-For are trusted proxies and no real-ip or connectionIp exists (#675)", async () => {
      vi.stubEnv("TRUSTED_PROXIES", "10.0.0.1, 10.0.0.2");
      const { clientIpFrom } = await import("./rate-limit");
      const headers = new Headers({ "x-forwarded-for": "10.0.0.2, 10.0.0.1" });
      expect(clientIpFrom(headers)).toBeNull();
    });

    it("ignores spoofed X-Forwarded-For when connectionIp is not a trusted proxy (#663)", async () => {
      vi.stubEnv("TRUSTED_PROXIES", "10.0.0.1, 10.0.0.2");
      const { clientIpFrom } = await import("./rate-limit");

      // Attacker connects directly from 198.51.100.99 and provides spoofed X-Forwarded-For
      const headers = new Headers({
        "x-forwarded-for": "8.8.8.8, 1.1.1.1",
      });
      expect(clientIpFrom(headers, "198.51.100.99")).toBe("198.51.100.99");
    });

    it("falls back to connectionIp when all forwarded headers are trusted proxies (#663)", async () => {
      vi.stubEnv("TRUSTED_PROXIES", "10.0.0.1, 10.0.0.2");
      const { clientIpFrom } = await import("./rate-limit");

      const headers = new Headers({ "x-forwarded-for": "10.0.0.2" });
      expect(clientIpFrom(headers, "10.0.0.1")).toBe("10.0.0.1");
    });

    it("falls back to connectionIp when TRUSTED_PROXY_HOPS is 0 (#663)", async () => {
      vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
      const { clientIpFrom } = await import("./rate-limit");

      const headers = new Headers({ "x-forwarded-for": "1.2.3.4" });
      expect(clientIpFrom(headers, "198.51.100.50")).toBe("198.51.100.50");
    });

    it("accepts request-like object with headers and ip in clientRateLimitKey (#663)", async () => {
      const { clientRateLimitKey } = await import("./rate-limit");
      const req = {
        headers: new Headers({ "x-forwarded-for": "203.0.113.19" }),
        ip: "10.0.0.1",
      };
      expect(clientRateLimitKey(req)).toBe("ip:203.0.113.19");
    });
  });

  describe("auth limits can't be dodged by rotating X-Forwarded-For (#508)", () => {
    it("keeps counting the same IP across many emails", async () => {
      const { checkAuthRateLimit, clientIpFrom, AUTH_RATE_LIMITS } = await import("./rate-limit");
      const { max } = AUTH_RATE_LIMITS.login.ip;
      const results = Array.from({ length: max + 1 }, (_, i) =>
        checkAuthRateLimit(
          "login",
          {
            email: `victim${i}@example.com`,
            ip: clientIpFrom(new Headers({ "x-forwarded-for": `10.9.${i}.1, 198.51.100.20` })),
          },
          0,
        ),
      );
      expect(results.slice(0, max).every((r) => r.allowed)).toBe(true);
      expect(results[max]?.allowed).toBe(false);
    });
  });

  describe("clientRateLimitKey (#509)", () => {
    it("keys by IP when there is one", async () => {
      const { clientRateLimitKey } = await import("./rate-limit");
      expect(clientRateLimitKey(new Headers({ "x-forwarded-for": "203.0.113.7" }))).toBe("ip:203.0.113.7");
    });

    it("gives header-less clients separate buckets instead of one shared one", async () => {
      const { clientRateLimitKey } = await import("./rate-limit");
      const a = clientRateLimitKey(new Headers({ "user-agent": "agent-a/1.0" }));
      const b = clientRateLimitKey(new Headers({ "user-agent": "agent-b/1.0" }));
      expect(a).toMatch(/^anon:[0-9a-f]{32}$/);
      expect(a).not.toBe(b);
      expect(clientRateLimitKey(new Headers({ "user-agent": "agent-a/1.0" }))).toBe(a);
      expect(a).not.toBe("unknown");
    });
  });

  it("drops expired keys once it tracks many, so memory stays bounded", async () => {
    const { checkRateLimit, trackedKeyCount } = await import("./rate-limit");
    for (let i = 0; i < 10_001; i++) checkRateLimit(`k${i}`, { max: 5, windowMs: 1000 }, 0);
    checkRateLimit("fresh", { max: 5, windowMs: 1000 }, 2 * 60 * 60 * 1000);
    expect(trackedKeyCount()).toBe(1);
  });
});

describe("action rate limits (#350)", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("enforces editComment rate limit", () => {
    const key = "edit-comment:user-1";
    for (let i = 0; i < ACTION_RATE_LIMITS.editComment.max; i++) {
      expect(checkRateLimit(key, ACTION_RATE_LIMITS.editComment, 1000 + i).allowed).toBe(true);
    }
    expect(checkRateLimit(key, ACTION_RATE_LIMITS.editComment, 1100).allowed).toBe(false);
  });

  it("enforces editBug rate limit", () => {
    const key = "edit-bug:user-1";
    for (let i = 0; i < ACTION_RATE_LIMITS.editBug.max; i++) {
      expect(checkRateLimit(key, ACTION_RATE_LIMITS.editBug, 1000 + i).allowed).toBe(true);
    }
    expect(checkRateLimit(key, ACTION_RATE_LIMITS.editBug, 1100).allowed).toBe(false);
  });

  it("enforces selfAssign rate limit", () => {
    const key = "self-assign:user-1";
    for (let i = 0; i < ACTION_RATE_LIMITS.selfAssign.max; i++) {
      expect(checkRateLimit(key, ACTION_RATE_LIMITS.selfAssign, 1000 + i).allowed).toBe(true);
    }
    expect(checkRateLimit(key, ACTION_RATE_LIMITS.selfAssign, 1100).allowed).toBe(false);
  });
});

