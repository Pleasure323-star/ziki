import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  default: () => ({
    auth: (fn: (req: unknown) => unknown) => fn,
  }),
}));

import middleware, { isPublicPath } from "./middleware";

type MockRequest = {
  nextUrl: URL;
  auth: { user: { id: string; email: string } } | null;
  headers: Headers;
};

function createMockReq({
  pathname,
  search = "",
  isLoggedIn = false,
  userAgent = "Mozilla/5.0",
}: {
  pathname: string;
  search?: string;
  isLoggedIn?: boolean;
  userAgent?: string;
}): MockRequest {
  const url = new URL(`https://ziki.dev${pathname}${search}`);
  return {
    nextUrl: url,
    auth: isLoggedIn ? { user: { id: "u1", email: "user@test.com" } } : null,
    headers: new Headers({
      "user-agent": userAgent,
    }),
  };
}

const runMiddleware = (req: MockRequest): Response => {
  return (middleware as unknown as (r: unknown) => Response)(req);
};

describe("isPublicPath (#348)", () => {
  it("treats root path / as public", () => {
    expect(isPublicPath("/")).toBe(true);
  });

  it("treats /session-expired as public", () => {
    expect(isPublicPath("/session-expired")).toBe(true);
    expect(isPublicPath("/session-expired/")).toBe(true);
  });

  it("treats the root homepage and /llms.txt as public (#487)", () => {
    expect(isPublicPath("/")).toBe(true);
    expect(isPublicPath("")).toBe(true);
    expect(isPublicPath("/llms.txt")).toBe(true);
  });

  it("treats auth and password reset pages as public", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/signup")).toBe(true);
    expect(isPublicPath("/forgot-password")).toBe(true);
    expect(isPublicPath("/reset-password")).toBe(true);
  });

  it("treats api endpoints and assets as public", () => {
    expect(isPublicPath("/api/auth/session")).toBe(true);
    expect(isPublicPath("/api/health")).toBe(true);
    expect(isPublicPath("/_next/static/chunk.js")).toBe(true);
    expect(isPublicPath("/favicon.ico")).toBe(true);
  });

  it("lets the scheduler reach the cron runner, and nothing else under /api/internal (#571)", () => {
    expect(isPublicPath("/api/internal/cron")).toBe(true);
    expect(isPublicPath("/api/internal")).toBe(false);
    expect(isPublicPath("/api/internal/cron/extra")).toBe(false);
    expect(isPublicPath("/api/internal/other")).toBe(false);
  });

  it("lets the agent API through; its routes check the agent key (#427)", () => {
    expect(isPublicPath("/api/v1/agents/me")).toBe(true);
    expect(isPublicPath("/api/v1/agents/pairing")).toBe(true);
    // Only the versioned agent API, not the session-only routes beside it.
    expect(isPublicPath("/api/v1")).toBe(false);
    expect(isPublicPath("/api/issues/similar")).toBe(false);
    expect(isPublicPath("/api/attachments/a1")).toBe(false);
  });

  it("lets guests open a shareable invite link without signing in first", () => {
    expect(isPublicPath("/join")).toBe(true);
    expect(isPublicPath("/join/abc")).toBe(true);
    expect(isPublicPath("/joining")).toBe(false);
    expect(isPublicPath("/tenants/invite/abc")).toBe(false);
  });

  it("lets guests open design-prototype previews without an account", () => {
    expect(isPublicPath("/preview/outcome-radar")).toBe(true);
    expect(isPublicPath("/preview/other")).toBe(true);
    // Only the previews; normal app routes stay protected.
    expect(isPublicPath("/preview")).toBe(true);
    expect(isPublicPath("/previewing")).toBe(false);
    expect(isPublicPath("/dashboard")).toBe(false);
  });

  it("treats application routes as non-public", () => {
    expect(isPublicPath("/issues")).toBe(false);
    expect(isPublicPath("/issues/new")).toBe(false);
    expect(isPublicPath("/admin")).toBe(false);
    expect(isPublicPath("/admin/users")).toBe(false);
  });
});

describe("middleware routing (#348)", () => {
  it("allows unauthenticated requests to / without redirecting to /login (#487)", () => {
    const req = createMockReq({ pathname: "/", isLoggedIn: false });
    const res = runMiddleware(req);

    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });

  it("lets an unauthenticated scheduler call reach /api/internal/cron instead of /login (#571)", () => {
    const res = runMiddleware(createMockReq({ pathname: "/api/internal/cron", isLoggedIn: false }));

    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });

  it("allows unauthenticated requests to /session-expired without redirecting to /login", () => {
    const req = createMockReq({ pathname: "/session-expired", isLoggedIn: false });
    const res = runMiddleware(req);

    // Should not redirect to login
    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects legacy /bugs requests to /issues with 308 permanent redirect", () => {
    const req = createMockReq({ pathname: "/bugs", isLoggedIn: false });
    const res = runMiddleware(req);

    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://ziki.dev/issues");
  });

  it("lets a guest open a shareable invite link", () => {
    const req = createMockReq({ pathname: "/join/abc", isLoggedIn: false });
    const res = runMiddleware(req);

    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });

  it("lets a guest open the design-prototype preview without redirecting to /login", () => {
    const req = createMockReq({ pathname: "/preview/outcome-radar", isLoggedIn: false });
    const res = runMiddleware(req);

    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects unauthenticated requests to protected pages to /login with callbackUrl", () => {
    const req = createMockReq({ pathname: "/issues", isLoggedIn: false });
    const res = runMiddleware(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toContain("/login");
    expect(location).toContain("callbackUrl=%2Fissues");
  });

  it("keeps the agent approval code across the sign-in redirect", () => {
    const req = createMockReq({
      pathname: "/settings/agents/pair",
      search: "?code=KX7P-2MQD",
      isLoggedIn: false,
    });
    const res = runMiddleware(req);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login");
    expect(location).toContain(encodeURIComponent("/settings/agents/pair?code=KX7P-2MQD"));
  });

  it("redirects logged-in users visiting /login to /dashboard", () => {
    const req = createMockReq({ pathname: "/login", isLoggedIn: true });
    const res = runMiddleware(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://ziki.dev/dashboard");
  });

  it("allows logged-in users to proceed to protected pages", () => {
    const req = createMockReq({ pathname: "/issues", isLoggedIn: true });
    const res = runMiddleware(req);

    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });
});
