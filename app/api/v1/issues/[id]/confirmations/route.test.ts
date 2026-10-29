import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  agentApiKey: { findUnique: vi.fn() },
  agentAuditEvent: { create: vi.fn() },
  project: { findFirst: vi.fn() },
}));
const budget = vi.hoisted(() => vi.fn());
const giveConfirmation = vi.hoisted(() => vi.fn());
const listConfirmations = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agents/rate-budget", async (original) => ({
  ...await original<typeof import("@/lib/agents/rate-budget")>(),
  consumeAgentBudget: budget,
}));
vi.mock("@/lib/agent-api/confirmations", async (original) => ({
  ...await original<typeof import("@/lib/agent-api/confirmations")>(),
  giveConfirmation,
  listConfirmations,
}));

import { GET, POST } from "./route";
import { POST as VALIDATIONS_POST } from "../validations/route";
import { IssueApiError } from "@/lib/agent-api/errors";

const context = { params: Promise.resolve({ id: "bug1" }) };

function key() {
  return {
    id: "key-a",
    revokedAt: null,
    agent: {
      id: "agent-bob",
      name: "Bob's agent",
      ownerUserId: "bob",
      tenantId: "t1",
      level: "working",
      burst: false,
      revokedAt: null,
      owner: { memberships: [{ tenantId: "t1" }] },
    },
  };
}

function request(method: "GET" | "POST", body?: unknown, { auth = true, path = "confirmations" } = {}) {
  return new NextRequest(`http://localhost/api/v1/issues/bug1/${path}?projectId=p1`, {
    method,
    headers: { ...(auth ? { authorization: "Bearer ziki_test-key" } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

const entry = { verdict: "confirm", summary: "Reproduced it.", description: "Steps and result.", severity: "high" };

beforeEach(() => {
  vi.resetAllMocks();
  db.agentApiKey.findUnique.mockResolvedValue(key());
  db.project.findFirst.mockResolvedValue({ id: "p1" });
  budget.mockResolvedValue({ allowed: true });
  giveConfirmation.mockResolvedValue({ confirmation: { id: "c1" }, replaced: false, confirmed: false, newlyConfirmed: false, confirmations: 1, confirmationsNeeded: 2 });
  listConfirmations.mockResolvedValue({ issueId: "bug1", entries: [] });
});

describe("POST /api/v1/issues/{id}/confirmations (#issue-confirmations)", () => {
  it("gives the owner's entry and answers 201, or 200 when it replaced one", async () => {
    const response = await POST(request("POST", entry), context);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ confirmation: { id: "c1" }, confirmations: 1 });
    expect(giveConfirmation).toHaveBeenCalledWith(
      { tenantId: "t1", userId: "bob", agent: { id: "agent-bob", level: "working" } },
      { tenantId: "t1", projectId: "p1" },
      "bug1",
      entry,
    );
    giveConfirmation.mockResolvedValueOnce({ confirmation: { id: "c1" }, replaced: true });
    expect((await POST(request("POST", entry), context)).status).toBe(200);
  });

  it("answers 401 without an agent key", async () => {
    expect((await POST(request("POST", entry, { auth: false }), context)).status).toBe(401);
    expect(giveConfirmation).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not a JSON object, and passes on the service's 400 and 404", async () => {
    expect((await POST(request("POST", "[1]"), context)).status).toBe(400);
    expect((await POST(request("POST", "not json"), context)).status).toBe(400);

    giveConfirmation.mockRejectedValueOnce(new IssueApiError(400, "Add a summary.", { error: "invalid_request", message: "Add a summary.", field: "summary" }));
    const bare = await POST(request("POST", { verdict: "confirm" }), context);
    expect(bare.status).toBe(400);
    expect(await bare.json()).toMatchObject({ error: "invalid_request", field: "summary" });

    giveConfirmation.mockRejectedValueOnce(new IssueApiError(404, "No such issue in this project.", { error: "not_found", message: "No such issue in this project." }));
    expect((await POST(request("POST", entry), context)).status).toBe(404);
  });
});

describe("GET /api/v1/issues/{id}/confirmations", () => {
  it("lists the entries in the project", async () => {
    const response = await GET(request("GET"), context);
    expect(response.status).toBe(200);
    expect(listConfirmations).toHaveBeenCalledWith({ tenantId: "t1", projectId: "p1" }, "bug1");
  });

  it("answers 401 without a key and 404 for a project outside the tenant", async () => {
    expect((await GET(request("GET", undefined, { auth: false }), context)).status).toBe(401);
    db.project.findFirst.mockResolvedValue(null);
    expect((await GET(request("GET"), context)).status).toBe(404);
  });
});

describe("POST /api/v1/issues/{id}/validations (retired)", () => {
  it("answers 410 Gone, points to confirmations, and spends no budget", async () => {
    const response = await VALIDATIONS_POST(request("POST", { kind: "real", verdict: "accept" }, { path: "validations" }), context);
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: "gone", use: "/api/v1/issues/bug1/confirmations" });
    expect(budget).not.toHaveBeenCalled();
    expect(giveConfirmation).not.toHaveBeenCalled();
  });
});
