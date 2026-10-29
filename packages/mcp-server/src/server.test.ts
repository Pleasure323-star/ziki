import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZikiClient } from "./client.js";
import { createServer } from "./server.js";
import { TOOLS } from "./tools.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
let client: Client;

beforeEach(async () => {
  fetchMock = vi.fn(async () => json({ ok: true }));
  const api = new ZikiClient({ url: "https://ziki.test", apiKey: "secret-key", projectId: "proj_1" }, fetchMock as unknown as typeof fetch);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(api).connect(serverSide);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
});

const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const sent = () => {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: new URL(url as URL), init: init as RequestInit };
};

describe("tools over MCP", () => {
  it("lists every tool with schema-derived descriptions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
    const comment = tools.find((tool) => tool.name === "ziki_comment")!;
    const properties = comment.inputSchema.properties as Record<string, { description?: string; maxLength?: number; enum?: string[] }>;
    expect(properties.body.maxLength).toBe(2000);
    expect(properties.body.description).toMatch(/2000/);
    expect(properties.type.enum).toContain("delivery");
    expect(comment.inputSchema.required).toEqual(expect.arrayContaining(["id", "body"]));
  });

  it("lists issues with filters and the bearer key", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: "i1" }], nextCursor: null }));
    const result = await call("ziki_list_issues", { status: "open", area: "none", stage: "confirming", limit: 10 });
    const { url, init } = sent();
    expect(url.pathname).toBe("/api/v1/issues");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: "open",
      area: "none",
      stage: "confirming",
      limit: "10",
      projectId: "proj_1",
    });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("i1");
  });

  it("comments on an issue", async () => {
    await call("ziki_comment", { id: "i1", body: "Fixed", type: "delivery", metadata: { prUrl: "https://github.com/o/r/pull/1" } });
    const { url, init } = sent();
    expect(init.method).toBe("POST");
    expect(url.pathname).toBe("/api/v1/issues/i1/comments");
    expect(JSON.parse(init.body as string)).toEqual({ body: "Fixed", type: "delivery", metadata: { prUrl: "https://github.com/o/r/pull/1" } });
  });

  it("covers the issue lifecycle routes", async () => {
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ["ziki_volunteer", { id: "i1", note: "I can" }, "POST", "/api/v1/issues/i1/bid"],
      ["ziki_request_offer", { id: "i1" }, "POST", "/api/v1/issues/i1/offer"],
      ["ziki_accept_offer", { id: "c1" }, "POST", "/api/v1/offers/c1/accept"],
      ["ziki_heartbeat", { id: "i1" }, "POST", "/api/v1/issues/i1/heartbeat"],
      ["ziki_link_pull_request", { id: "i1", pullRequestUrl: "https://github.com/o/r/pull/9" }, "POST", "/api/v1/issues/i1/github"],
      ["ziki_confirm_issue", { id: "i1", verdict: "confirm", summary: "Reproduced it.", description: "Steps and result.", severity: "high" }, "POST", "/api/v1/issues/i1/confirmations"],
      ["ziki_list_confirmations", { id: "i1" }, "GET", "/api/v1/issues/i1/confirmations"],
      ["ziki_submit_test_result", { id: "i1", goodToMerge: true }, "POST", "/api/v1/issues/i1/test-results"],
      ["ziki_ask_owner", { body: "Which endpoint?", bugId: "i1" }, "POST", "/api/v1/questions"],
      ["ziki_read_inbox", { unread: true, wait: 0 }, "GET", "/api/v1/inbox"],
    ];
    for (const [name, args, method, pathname] of cases) {
      const result = await call(name, args);
      expect(result.isError, name).toBeFalsy();
      expect(sent().init.method, name).toBe(method);
      expect(sent().url.pathname, name).toBe(pathname);
    }
  });

  it("files an idea without sending fields the route rejects", async () => {
    await call("ziki_create_idea", { title: "Bug title", description: "Steps to reproduce it" });
    expect(JSON.parse(sent().init.body as string)).toEqual({ title: "Bug title", description: "Steps to reproduce it" });
    expect((sent().init.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
  });

  it("returns API errors as tool errors the assistant can act on", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "Offer expired." }, 410));
    const result = await call("ziki_accept_offer", { id: "c1" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("410");
    expect(JSON.stringify(result.content)).toContain("Offer expired.");
  });

  it("rejects invalid input without calling the API", async () => {
    fetchMock.mockClear();
    const result = await call("ziki_comment", { id: "i1", body: "x".repeat(2001) });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never leaks the key in results", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "bad" }, 401));
    const result = await call("ziki_whoami");
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });
});
