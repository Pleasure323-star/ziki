import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const resolve = vi.hoisted(() => vi.fn());
const link = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/github/pr-merged", async (original) => ({
  ...(await original<typeof import("@/lib/github/pr-merged")>()), resolveIssuesForMergedPullRequest: resolve,
}));
vi.mock("@/lib/github/pr-opened", async (original) => ({
  ...(await original<typeof import("@/lib/github/pr-opened")>()), refreshDeliveredPullRequest: link,
}));
import { POST } from "./route";

const SECRET = "whsec";
function call(body: object, { event = "pull_request", secret = SECRET, signWith = SECRET } = {}) {
  const raw = JSON.stringify(body);
  if (secret) process.env.GITHUB_WEBHOOK_SECRET = secret; else delete process.env.GITHUB_WEBHOOK_SECRET;
  return POST(new NextRequest("http://localhost/api/github/webhook", {
    method: "POST", body: raw,
    headers: { "x-github-event": event, "x-hub-signature-256": `sha256=${createHmac("sha256", signWith).update(raw).digest("hex")}` },
  }));
}
afterEach(() => { resolve.mockReset(); link.mockReset(); delete process.env.GITHUB_WEBHOOK_SECRET; });

describe("POST /api/github/webhook (#474)", () => {
  const merged = { action: "closed", pull_request: { merged: true, html_url: "https://github.com/o/r/pull/9" } };
  it("is unavailable without a configured secret and rejects a bad signature", async () => {
    expect((await call(merged, { secret: "" })).status).toBe(503);
    expect((await call(merged, { signWith: "wrong" })).status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
  });
  it("resolves issues for a merged pull request", async () => {
    resolve.mockResolvedValue(["bug-1"]);
    const response = await call(merged);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resolved: ["bug-1"] });
    expect(resolve).toHaveBeenCalledWith("https://github.com/o/r/pull/9");
  });
  it("refreshes the head commit of issues the pull request was delivered to", async () => {
    link.mockResolvedValue(["bug-2"]);
    const response = await call({
      action: "opened",
      pull_request: {
        html_url: "https://github.com/o/r/pull/10",
        title: "Fixes #490",
        body: null,
        head: { ref: "fix/ziki-490", sha: "sha-1" },
      },
      repository: { html_url: "https://github.com/o/r" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ refreshed: ["bug-2"] });
    expect(link).toHaveBeenCalledWith({
      pullRequestUrl: "https://github.com/o/r/pull/10",
      headSha: "sha-1",
      repositoryUrl: "https://github.com/o/r",
    });
  });
  it("ignores closed-without-merge, other actions and other events", async () => {
    expect((await call({ action: "closed", pull_request: { merged: false, html_url: "u" } })).status).toBe(202);
    expect((await call({ action: "assigned", pull_request: { html_url: "u" }, repository: { html_url: "r" } })).status).toBe(202);
    expect((await call(merged, { event: "push" })).status).toBe(202);
    expect((await call({}, { event: "ping" })).status).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
  });
});
