import { describe, expect, it, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { NextRequest } from "next/server";
import { IssueApiError } from "@/lib/agent-api/errors";

vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: vi.fn(),
}));

vi.mock("@/lib/tenant-context", () => ({
  currentTenantIdFor: vi.fn(),
}));

vi.mock("@/lib/approvals", () => ({
  decideApproval: vi.fn(),
}));

import { resolveSessionUserId } from "@/lib/session-user";
import { currentTenantIdFor } from "@/lib/tenant-context";
import { decideApproval } from "@/lib/approvals";

describe("POST /api/v1/approvals/[id]/decision (#598)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeRequest(body: unknown, options: { authorization?: string; origin?: string } = {}) {
    const headers = new Headers();
    if (options.authorization) headers.set("authorization", options.authorization);
    if (options.origin) headers.set("origin", options.origin);
    headers.set("content-type", "application/json");

    return new NextRequest("http://localhost:3000/api/v1/approvals/appr-1/decision", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  it("rejects agent authorization tokens (must be a human)", async () => {
    const req = makeRequest({ decision: "approved" }, { authorization: "Bearer ziki_key" });
    const res = await POST(req, { params: Promise.resolve({ id: "appr-1" }) });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toEqual(expect.any(String));
  });

  it("requires authenticated session", async () => {
    vi.mocked(resolveSessionUserId).mockResolvedValue({ error: "no_session" } as never);
    const req = makeRequest({ decision: "approved" });
    const res = await POST(req, { params: Promise.resolve({ id: "appr-1" }) });
    expect(res.status).toBe(401);
  });

  it("requires workspace tenant membership", async () => {
    vi.mocked(resolveSessionUserId).mockResolvedValue({ userId: "u1" });
    vi.mocked(currentTenantIdFor).mockResolvedValue(null);

    const req = makeRequest({ decision: "approved" });
    const res = await POST(req, { params: Promise.resolve({ id: "appr-1" }) });
    expect(res.status).toBe(403);
  });

  it("validates request body decision", async () => {
    vi.mocked(resolveSessionUserId).mockResolvedValue({ userId: "u1" });
    vi.mocked(currentTenantIdFor).mockResolvedValue("t1");

    const req = makeRequest({ decision: "invalid" });
    const res = await POST(req, { params: Promise.resolve({ id: "appr-1" }) });
    expect(res.status).toBe(400);
  });

  it("approves successfully and returns result", async () => {
    vi.mocked(resolveSessionUserId).mockResolvedValue({ userId: "u1" });
    vi.mocked(currentTenantIdFor).mockResolvedValue("t1");
    vi.mocked(decideApproval).mockResolvedValue({
      id: "appr-1",
      status: "approved",
      decidedByUserId: "u1",
    } as never);

    const req = makeRequest({ decision: "approved" });
    const res = await POST(req, { params: Promise.resolve({ id: "appr-1" }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.approval.status).toBe("approved");
    expect(decideApproval).toHaveBeenCalledWith("u1", "t1", "appr-1", "approved");
  });

  it("rejects successfully and returns result", async () => {
    vi.mocked(resolveSessionUserId).mockResolvedValue({ userId: "u1" });
    vi.mocked(currentTenantIdFor).mockResolvedValue("t1");
    vi.mocked(decideApproval).mockResolvedValue({
      id: "appr-1",
      status: "rejected",
      decidedByUserId: "u1",
    } as never);

    const req = makeRequest({ decision: "rejected" });
    const res = await POST(req, { params: Promise.resolve({ id: "appr-1" }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.approval.status).toBe("rejected");
    expect(decideApproval).toHaveBeenCalledWith("u1", "t1", "appr-1", "rejected");
  });

  it("propagates IssueApiError status", async () => {
    vi.mocked(resolveSessionUserId).mockResolvedValue({ userId: "u1" });
    vi.mocked(currentTenantIdFor).mockResolvedValue("t1");
    vi.mocked(decideApproval).mockRejectedValue(
      new IssueApiError(403, "Only workspace owners and admins can decide approvals."),
    );

    const req = makeRequest({ decision: "approved" });
    const res = await POST(req, { params: Promise.resolve({ id: "appr-1" }) });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("Only workspace owners and admins can decide approvals.");
  });
});
