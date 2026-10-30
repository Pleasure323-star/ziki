import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  bug: { findFirst: vi.fn(), update: vi.fn() },
  agentAuditEvent: { findFirst: vi.fn(), create: vi.fn() },
  agentEvent: { create: vi.fn() },
  webhookSubscription: { findMany: vi.fn() },
  webhookDelivery: { createMany: vi.fn() },
  projectWorkflow: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

const notify = vi.hoisted(() => ({ notifyMergeFailed: vi.fn() }));
vi.mock("@/lib/agent-notifications", () => ({ notifyMergeFailed: notify.notifyMergeFailed }));

import {
  createAppJwt,
  createInstallationClient,
  mergeAcceptedFix,
  parseGitHubRepoUrl,
  parsePullRequestUrl,
  sameRepo,
  type GitHubClient,
} from "./merge-pr";
import { resetWorkflowCache } from "@/lib/workflow";

const agent = {
  agentId: "m1",
  name: "merger-bot",
  ownerId: "owner",
  tenantId: "t1",
  level: "manager" as const,
  burst: false,
  keyId: "k",
};

function bugRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bug1",
    title: "Fix the thing",
    tenantId: "t1",
    projectId: "project-1",
    pullRequestUrl: "https://github.com/zedu/web/pull/7",
    assigneeId: "ada",
    project: { repoUrl: "https://github.com/zedu/web", githubInstallationId: "12345" },
    claims: [{ beneficiaryUserId: "ada" }],
    ...overrides,
  };
}

function fakeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    getPullRequest: vi.fn(async () => ({ merged: false, mergeable: true, headSha: "head-sha" })),
    checksGreen: vi.fn(async () => true),
    unresolvedCodeRabbitThreads: vi.fn(async () => 0),
    mergePullRequest: vi.fn(async () => ({ merged: true, sha: "merge-sha" })),
    ...overrides,
  };
}

function jsonResponse(data: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => data, headers: new Headers() } as unknown as Response;
}

/** Route GitHub's endpoints to canned responses; anything else 500s. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const tokenRoute = (url: string) =>
  url.endsWith("/access_tokens") ? jsonResponse({ token: "ghs_test" }) : null;

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  db.bug.findFirst.mockResolvedValue(bugRow());
  db.agentAuditEvent.findFirst.mockResolvedValue({ id: "accepted-1" });
  db.agentAuditEvent.create.mockResolvedValue({});
  db.agentEvent.create.mockResolvedValue({ id: "event-1" });
  db.webhookSubscription.findMany.mockResolvedValue([]);
  db.projectWorkflow.findUnique.mockResolvedValue(null);
  resetWorkflowCache();
});

describe("parseGitHubRepoUrl (#452)", () => {
  it("reads https and scp-style GitHub URLs, ignoring .git", () => {
    expect(parseGitHubRepoUrl("https://github.com/zedu/web.git")).toEqual({ owner: "zedu", repo: "web" });
    expect(parseGitHubRepoUrl("https://github.com/zedu/web")).toEqual({ owner: "zedu", repo: "web" });
    expect(parseGitHubRepoUrl("git@github.com:zedu/web.git")).toEqual({ owner: "zedu", repo: "web" });
  });

  it("rejects other hosts and empty input", () => {
    expect(parseGitHubRepoUrl("https://gitlab.com/zedu/web")).toBeNull();
    expect(parseGitHubRepoUrl("not a url")).toBeNull();
    expect(parseGitHubRepoUrl(null)).toBeNull();
  });
});

describe("parsePullRequestUrl (#452)", () => {
  it("reads a pull request URL", () => {
    expect(parsePullRequestUrl("https://github.com/zedu/web/pull/7")).toEqual({
      owner: "zedu",
      repo: "web",
      number: 7,
    });
  });

  it("rejects non-PR and non-GitHub URLs", () => {
    expect(parsePullRequestUrl("https://github.com/zedu/web")).toBeNull();
    expect(parsePullRequestUrl("https://gitlab.com/zedu/web/pull/7")).toBeNull();
  });
});

describe("sameRepo (#452)", () => {
  it("compares case-insensitively", () => {
    expect(sameRepo({ owner: "Zedu", repo: "Web" }, { owner: "zedu", repo: "web" })).toBe(true);
    expect(sameRepo({ owner: "zedu", repo: "web" }, { owner: "zedu", repo: "desktop" })).toBe(false);
  });
});

describe("createAppJwt (#452)", () => {
  it("signs a verifiable RS256 app JWT with the app id as issuer", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = createAppJwt("123456", privateKey.export({ type: "pkcs1", format: "pem" }).toString(), 1_700_000_000_000);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims.iss).toBe("123456");
    expect(claims.exp - claims.iat).toBe(9 * 60);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("handles base64, collapsed spaces, and escaped newlines in private key", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

    // Base64-encoded PEM
    const b64 = Buffer.from(pem).toString("base64");
    expect(() => createAppJwt("123", b64)).not.toThrow();

    // Collapsed spaces on a single line
    const singleLine = pem.replace(/\r?\n/g, " ");
    expect(() => createAppJwt("123", singleLine)).not.toThrow();

    // Literal escaped newlines
    const escaped = pem.replace(/\n/g, "\\n");
    expect(() => createAppJwt("123", escaped)).not.toThrow();
  });

  it("throws helpful error when key is missing PEM header", () => {
    expect(() => createAppJwt("123", "some-random-client-secret-value")).toThrow(
      /missing the '-----BEGIN \.\.\. PRIVATE KEY-----' header/
    );
  });
});

describe("mergeAcceptedFix gates (#452)", () => {
  it("does not attempt a merge before the tracker accepts the fix", async () => {
    db.agentAuditEvent.findFirst.mockResolvedValue(null);
    const client = fakeClient();

    const result = await mergeAcceptedFix(agent, "bug1", { client });

    expect(result).toMatchObject({ status: 409, reason: "not_accepted" });
    expect(client.getPullRequest).not.toHaveBeenCalled();
    expect(notify.notifyMergeFailed).not.toHaveBeenCalled();
  });

  it("refuses to merge an acceptance a tenant admin has undone (#490)", async () => {
    // A fake table holding only an undone acceptance row: the lookup must
    // filter on `undoneAt: null` or it comes back and the merge goes ahead.
    const rows = [{ id: "accepted-1", undoneAt: new Date("2026-10-19T10:00:00Z") }];
    db.agentAuditEvent.findFirst.mockImplementation(async (args: { where?: { undoneAt?: null } }) =>
      rows.find((row) => (args?.where?.undoneAt === null ? row.undoneAt === null : true)) ?? null,
    );
    const client = fakeClient();

    const result = await mergeAcceptedFix(agent, "bug1", { client });

    expect(result).toMatchObject({ status: 409, reason: "not_accepted" });
    expect(client.getPullRequest).not.toHaveBeenCalled();
    expect(client.mergePullRequest).not.toHaveBeenCalled();
  });

  it("still merges while the acceptance stands, never undone (#490)", async () => {
    const rows = [{ id: "accepted-1", undoneAt: null }];
    db.agentAuditEvent.findFirst.mockImplementation(async (args: { where?: { undoneAt?: null } }) =>
      rows.find((row) => (args?.where?.undoneAt === null ? row.undoneAt === null : true)) ?? null,
    );
    const client = fakeClient();

    const result = await mergeAcceptedFix(agent, "bug1", { client });

    expect(result).toMatchObject({ status: 200, merged: true });
  });

  it("refuses a different pull request than the one that was accepted (#489)", async () => {
    db.agentAuditEvent.findFirst.mockResolvedValue({
      id: "accepted-1",
      payload: { pullRequestUrl: "https://github.com/zedu/web/pull/3", headSha: "accepted-sha" },
    });
    const client = fakeClient();

    const result = await mergeAcceptedFix(agent, "bug1", { client });

    expect(result).toMatchObject({ status: 409, reason: "pull_request_changed" });
    expect(client.getPullRequest).not.toHaveBeenCalled();
    expect(client.mergePullRequest).not.toHaveBeenCalled();
  });

  it("refuses when commits landed on the accepted pull request after acceptance (#489)", async () => {
    db.agentAuditEvent.findFirst.mockResolvedValue({
      id: "accepted-1",
      payload: { pullRequestUrl: "https://github.com/zedu/web/pull/7", headSha: "accepted-sha" },
    });
    const client = fakeClient({
      getPullRequest: vi.fn(async () => ({ merged: false, mergeable: true, headSha: "new-sha" })),
    });

    const result = await mergeAcceptedFix(agent, "bug1", { client });

    expect(result).toMatchObject({ status: 409, reason: "head_moved" });
    expect(client.mergePullRequest).not.toHaveBeenCalled();
  });

  it("merges when the linked pull request and head commit are the accepted ones (#489)", async () => {
    db.agentAuditEvent.findFirst.mockResolvedValue({
      id: "accepted-1",
      payload: { pullRequestUrl: "https://github.com/zedu/web/pull/7", headSha: "head-sha" },
    });
    const client = fakeClient();

    const result = await mergeAcceptedFix(agent, "bug1", { client });

    expect(result).toMatchObject({ status: 200, merged: true });
  });

  it("rejects a pull request outside the project's repository", async () => {
    db.bug.findFirst.mockResolvedValue(
      bugRow({ pullRequestUrl: "https://github.com/someone/fork/pull/7" }),
    );
    const client = fakeClient();

    const result = await mergeAcceptedFix(agent, "bug1", { client });

    expect(result).toMatchObject({ status: 422, reason: "repo_mismatch" });
    expect(client.mergePullRequest).not.toHaveBeenCalled();
  });

  it("does not merge when the pull request is closed without being merged (#642)", async () => {
    const client = fakeClient({
      getPullRequest: vi.fn(async () => ({ state: "closed", merged: false, mergeable: false, headSha: "head-sha" })),
    });

    const result = await mergeAcceptedFix(agent, "bug1", { client });

    expect(result).toMatchObject({ status: 409, reason: "merge_failed", message: "The pull request is closed without being merged." });
    expect(client.mergePullRequest).not.toHaveBeenCalled();
    expect(db.agentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "github.merge_failed" }) }),
    );
  });

  it("does not merge while CodeRabbit has unresolved review threads", async () => {
    const client = fakeClient({ unresolvedCodeRabbitThreads: vi.fn(async () => 1) });

    const result = await mergeAcceptedFix(agent, "bug1", { client });

    expect(result).toMatchObject({ status: 409, reason: "review_threads", message: expect.stringContaining("1 unresolved review thread") });
    expect(client.mergePullRequest).not.toHaveBeenCalled();
    expect(db.agentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "github.merge_failed" }) }),
    );
  });

  it("does not merge when CodeRabbit's review threads can't be read", async () => {
    const client = fakeClient({ unresolvedCodeRabbitThreads: vi.fn(async () => { throw new Error("down"); }) });

    const result = await mergeAcceptedFix(agent, "bug1", { client });

    expect(result).toMatchObject({ status: 409, reason: "merge_failed" });
    expect(client.mergePullRequest).not.toHaveBeenCalled();
  });

  it("does not merge when the checks are red, and tells the claim's person", async () => {
    const client = fakeClient({ checksGreen: vi.fn(async () => false) });

    const result = await mergeAcceptedFix(agent, "bug1", { client });

    expect(result).toMatchObject({ status: 409, reason: "checks_failed" });
    expect(client.mergePullRequest).not.toHaveBeenCalled();
    expect(db.agentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "github.merge_failed" }) }),
    );
    expect(notify.notifyMergeFailed).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: "ada", bugId: "bug1" }),
    );
  });

  it("skips GitHub when the project turned automatic merging off (#595)", async () => {
    db.projectWorkflow.findUnique.mockResolvedValue({ autoMerge: false });
    const client = fakeClient();

    const result = await mergeAcceptedFix(agent, "bug1", { client });

    expect(result).toMatchObject({ status: 409, reason: "auto_merge_disabled" });
    expect(client.getPullRequest).not.toHaveBeenCalled();
    expect(client.mergePullRequest).not.toHaveBeenCalled();
  });

  it("does not merge without permission to merge the repo", async () => {
    const client = fakeClient({ mergePullRequest: vi.fn(async () => ({ merged: false, forbidden: true })) });

    const result = await mergeAcceptedFix(agent, "bug1", { client });

    expect(result).toMatchObject({ status: 403, reason: "no_permission" });
    expect(db.agentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "github.merge_failed" }) }),
    );
  });

  it("reports a moved head as its own failure and merges nothing (#492)", async () => {
    const client = fakeClient({ mergePullRequest: vi.fn(async () => ({ merged: false, conflict: true })) });

    const result = await mergeAcceptedFix(agent, "bug1", { client });

    expect(result).toMatchObject({ status: 409, reason: "head_moved" });
    expect(result.merged).toBe(false);
  });

  it("reports a repository that allows no merge method (#492)", async () => {
    const client = fakeClient({ mergePullRequest: vi.fn(async () => ({ merged: false, noAllowedMethod: true })) });

    const result = await mergeAcceptedFix(agent, "bug1", { client });

    expect(result).toMatchObject({ status: 422, reason: "merge_failed" });
    expect(result).toHaveProperty("message", expect.stringMatching(/merge method/i));
  });

  it("refuses to merge when no installation is configured", async () => {
    db.bug.findFirst.mockResolvedValue(
      bugRow({ project: { repoUrl: "https://github.com/zedu/web", githubInstallationId: null } }),
    );

    const result = await mergeAcceptedFix(agent, "bug1", {});

    expect(result).toMatchObject({ status: 403, reason: "no_permission" });
  });

  it("merges a green, in-repo pull request after acceptance and records the sha", async () => {
    const client = fakeClient();

    const result = await mergeAcceptedFix(agent, "bug1", { client });

    expect(result).toEqual({
      status: 200,
      merged: true,
      mergeCommitSha: "merge-sha",
      pullRequestUrl: "https://github.com/zedu/web/pull/7",
    });
    expect(client.getPullRequest).toHaveBeenCalledWith({ owner: "zedu", repo: "web", number: 7 });
    expect(client.mergePullRequest).toHaveBeenCalledWith({ owner: "zedu", repo: "web", number: 7 }, "head-sha");
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "github.merged",
          payload: { mergeCommitSha: "merge-sha", pullRequestUrl: "https://github.com/zedu/web/pull/7" },
        }),
      }),
    );
  });

  it("persists no token: it never writes the pull request back or stores a credential", async () => {
    const client = fakeClient();

    await mergeAcceptedFix(agent, "bug1", { client });

    expect(db.bug.update).not.toHaveBeenCalled();
    const writes = [
      ...db.agentAuditEvent.create.mock.calls,
      ...db.agentEvent.create.mock.calls,
    ];
    expect(JSON.stringify(writes)).not.toMatch(/token|ghs_|bearer/i);
  });
  it("does not merge and returns waiting_for_human when approval is pending (#598)", async () => {
    (db as Record<string, unknown>).approvalRule = {
      findMany: vi.fn(async () => [
        { id: "rule-1", stage: "before_merge", issueTypeId: null, fileGlob: null },
      ]),
    };
    (db as Record<string, unknown>).issueApproval = {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "appr-wait", status: "pending" })),
    };
    (db as Record<string, unknown>).membership = {
      findMany: vi.fn(async () => []),
    };

    const client = fakeClient();
    const result = await mergeAcceptedFix(agent, "bug1", { client, db: db as never });

    expect(result).toMatchObject({
      status: 409,
      merged: false,
      reason: "waiting_for_human",
      approvalId: "appr-wait",
    });
    expect(client.mergePullRequest).not.toHaveBeenCalled();
  });
});

describe("checksGreen against the GitHub API (#491)", () => {
  const ref = { owner: "zedu", repo: "web", number: 7 };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(data: unknown, ok = true): Response {
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => data,
      headers: new Headers(),
    } as unknown as Response;
  }

  /** Route GitHub's endpoints to canned responses; anything else throws. */
  function stubFetch(handler: (url: string, init?: RequestInit) => Response): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input), init),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const tokenRoute = (url: string) =>
    url.endsWith("/access_tokens") ? jsonResponse({ token: "ghs_test" }) : null;

  function checkRun(conclusion = "success") {
    return { status: "completed", conclusion };
  }

  it("treats a pending combined status with running checks as not green", async () => {
    stubFetch((url) =>
      tokenRoute(url) ??
      (url.includes("/check-runs")
        ? jsonResponse({ check_runs: [], total_count: 0 })
        : url.endsWith("/status")
          ? jsonResponse({ state: "pending", statuses: [{ context: "ci/build" }] })
          : jsonResponse({}, false)),
    );

    await expect(createInstallationClient("123", env).checksGreen(ref, "sha1")).resolves.toBe(false);
  });

  it("holds when the repository has no check runs and no statuses at all", async () => {
    stubFetch((url) =>
      tokenRoute(url) ??
      (url.includes("/check-runs")
        ? jsonResponse({ check_runs: [], total_count: 0 })
        : url.endsWith("/status")
          ? jsonResponse({ state: "pending", statuses: [] })
          : jsonResponse({}, false)),
    );

    await expect(createInstallationClient("123", env).checksGreen(ref, "sha1")).resolves.toBe(true);
  });

  it("passes on a success combined status", async () => {
    stubFetch((url) =>
      tokenRoute(url) ??
      (url.includes("/check-runs")
        ? jsonResponse({ check_runs: [], total_count: 0 })
        : url.endsWith("/status")
          ? jsonResponse({ state: "success", statuses: [{ context: "ci/build" }] })
          : jsonResponse({}, false)),
    );

    await expect(createInstallationClient("123", env).checksGreen(ref, "sha1")).resolves.toBe(true);
  });

  it("fails on a failure combined status", async () => {
    stubFetch((url) =>
      tokenRoute(url) ??
      (url.includes("/check-runs")
        ? jsonResponse({ check_runs: [], total_count: 0 })
        : url.endsWith("/status")
          ? jsonResponse({ state: "failure", statuses: [{ context: "ci/build" }] })
          : jsonResponse({}, false)),
    );

    await expect(createInstallationClient("123", env).checksGreen(ref, "sha1")).resolves.toBe(false);
  });

  it("fails closed when the check-runs request is refused, even with no statuses (#531)", async () => {
    // A 403 (no checks:read) used to fall through to "no statuses: green".
    stubFetch((url) =>
      tokenRoute(url) ??
      (url.includes("/check-runs")
        ? jsonResponse({ message: "Resource not accessible by integration" }, false)
        : url.endsWith("/status")
          ? jsonResponse({ state: "pending", statuses: [] })
          : jsonResponse({}, false)),
    );

    await expect(createInstallationClient("123", env).checksGreen(ref, "sha1")).resolves.toBe(false);
  });

  it("fails closed when a later check-runs page fails, instead of judging the pages it got (#531)", async () => {
    stubFetch((url) => {
      const token = tokenRoute(url);
      if (token) return token;
      if (url.includes("/check-runs")) {
        const page = Number(new URL(url).searchParams.get("page"));
        return page === 1
          ? jsonResponse({ check_runs: Array.from({ length: 100 }, () => checkRun()), total_count: 150 })
          : jsonResponse({}, false);
      }
      return jsonResponse({}, false);
    });

    await expect(createInstallationClient("123", env).checksGreen(ref, "sha1")).resolves.toBe(false);
  });

  it("reads past the first 30 check runs: a failure on page two blocks the merge", async () => {
    const fetchMock = stubFetch((url) => {
      const token = tokenRoute(url);
      if (token) return token;
      if (url.includes("/check-runs")) {
        const page = Number(new URL(url).searchParams.get("page"));
        const runs = page === 1 ? Array.from({ length: 100 }, () => checkRun()) : [checkRun("failure")];
        return jsonResponse({ check_runs: runs, total_count: 101 });
      }
      return jsonResponse({}, false);
    });

    await expect(createInstallationClient("123", env).checksGreen(ref, "sha1")).resolves.toBe(false);

    const runUrls = fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.includes("/check-runs"));
    expect(runUrls[0]).toContain("per_page=100");
    expect(runUrls).toHaveLength(2);
    expect(runUrls[1]).toContain("page=2");
  });

  it("is green when every run across all pages has completed successfully", async () => {
    stubFetch((url) => {
      const token = tokenRoute(url);
      if (token) return token;
      if (url.includes("/check-runs")) {
        const page = Number(new URL(url).searchParams.get("page"));
        const runs = page === 1 ? Array.from({ length: 100 }, () => checkRun()) : [checkRun()];
        return jsonResponse({ check_runs: runs, total_count: 101 });
      }
      return jsonResponse({}, false);
    });

    await expect(createInstallationClient("123", env).checksGreen(ref, "sha1")).resolves.toBe(true);
  });

  it("is not green while any run across pages is still in progress", async () => {
    stubFetch((url) => {
      const token = tokenRoute(url);
      if (token) return token;
      if (url.includes("/check-runs")) {
        const page = Number(new URL(url).searchParams.get("page"));
        const runs = page === 1 ? Array.from({ length: 100 }, () => checkRun()) : [{ status: "in_progress", conclusion: null }];
        return jsonResponse({ check_runs: runs, total_count: 101 });
      }
      return jsonResponse({}, false);
    });

    await expect(createInstallationClient("123", env).checksGreen(ref, "sha1")).resolves.toBe(false);
  });
});

describe("mergePullRequest pins the head SHA and picks an allowed method (#492)", () => {
  const ref = { owner: "zedu", repo: "web", number: 7 };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const repoUrl = "https://api.github.com/repos/zedu/web";
  const mergeUrl = "https://api.github.com/repos/zedu/web/pulls/7/merge";

  it("pins the verified head SHA and uses squash when the repo allows it", async () => {
    const fetchMock = stubFetch((url, init) => {
      const token = tokenRoute(url);
      if (token) return token;
      if (url === repoUrl && !init?.method) return jsonResponse({ allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true });
      if (url === mergeUrl) return jsonResponse({ merged: true, sha: "merge-sha" });
      return jsonResponse({}, false);
    });

    const result = await createInstallationClient("123", env).mergePullRequest(ref, "verified-sha");

    expect(result).toEqual({ merged: true, sha: "merge-sha" });
    const mergeCall = fetchMock.mock.calls.find((call) => String(call[0]) === mergeUrl);
    expect(mergeCall).toBeDefined();
    expect(JSON.parse(String(mergeCall![1]?.body))).toEqual({ merge_method: "squash", sha: "verified-sha" });
  });

  it("falls back to a merge commit when squash is disabled", async () => {
    const fetchMock = stubFetch((url, init) => {
      const token = tokenRoute(url);
      if (token) return token;
      if (url === repoUrl && !init?.method) return jsonResponse({ allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: false });
      if (url === mergeUrl) return jsonResponse({ merged: true, sha: "merge-sha" });
      return jsonResponse({}, false);
    });

    const result = await createInstallationClient("123", env).mergePullRequest(ref, "verified-sha");

    expect(result.merged).toBe(true);
    const mergeCall = fetchMock.mock.calls.find((call) => String(call[0]) === mergeUrl);
    expect(JSON.parse(String(mergeCall![1]?.body))).toEqual({ merge_method: "merge", sha: "verified-sha" });
  });

  it("falls back to squash when repo settings omit merge methods (non-admin integration caller)", async () => {
    const fetchMock = stubFetch((url, init) => {
      const token = tokenRoute(url);
      if (token) return token;
      // When caller lacks repo admin permission, GitHub returns 200 with these fields undefined
      if (url === repoUrl && !init?.method) return jsonResponse({});
      if (url === mergeUrl) return jsonResponse({ merged: true, sha: "merge-sha" });
      return jsonResponse({}, false);
    });

    const result = await createInstallationClient("123", env).mergePullRequest(ref, "verified-sha");

    expect(result.merged).toBe(true);
    const mergeCall = fetchMock.mock.calls.find((call) => String(call[0]) === mergeUrl);
    expect(JSON.parse(String(mergeCall![1]?.body))).toEqual({ merge_method: "squash", sha: "verified-sha" });
  });

  it("refuses to guess when the repository allows no merge method at all", async () => {
    const fetchMock = stubFetch((url, init) => {
      const token = tokenRoute(url);
      if (token) return token;
      if (url === repoUrl && !init?.method) return jsonResponse({ allow_squash_merge: false, allow_merge_commit: false, allow_rebase_merge: false });
      return jsonResponse({}, false);
    });

    const result = await createInstallationClient("123", env).mergePullRequest(ref, "verified-sha");

    expect(result).toEqual({ merged: false, noAllowedMethod: true });
    expect(fetchMock.mock.calls.some((call) => String(call[0]) === mergeUrl)).toBe(false);
  });

  it("maps GitHub's 409 to a conflict so the caller can say the head moved", async () => {
    stubFetch((url, init) => {
      const token = tokenRoute(url);
      if (token) return token;
      if (url === repoUrl && !init?.method) return jsonResponse({ allow_squash_merge: true });
      if (url === mergeUrl) return jsonResponse({}, false, 409);
      return jsonResponse({}, false);
    });

    const result = await createInstallationClient("123", env).mergePullRequest(ref, "verified-sha");

    expect(result).toEqual({ merged: false, conflict: true });
  });

  it("maps GitHub's 405 to an actionable no-allowed-method failure", async () => {
    // The repo settings read fails, so the client falls back to squash and
    // GitHub answers 405 Method Not Allowed.
    stubFetch((url) => {
      const token = tokenRoute(url);
      if (token) return token;
      if (url === mergeUrl) return jsonResponse({}, false, 405);
      return jsonResponse({}, false);
    });

    const result = await createInstallationClient("123", env).mergePullRequest(ref, "verified-sha");

    expect(result).toEqual({ merged: false, noAllowedMethod: true });
  });

  it("still maps 403 to forbidden", async () => {
    stubFetch((url, init) => {
      const token = tokenRoute(url);
      if (token) return token;
      if (url === repoUrl && !init?.method) return jsonResponse({ allow_squash_merge: true });
      if (url === mergeUrl) return jsonResponse({}, false, 403);
      return jsonResponse({}, false);
    });

    const result = await createInstallationClient("123", env).mergePullRequest(ref, "verified-sha");

    expect(result).toEqual({ merged: false, forbidden: true });
  });
});

describe("unresolvedCodeRabbitThreads against the GitHub API", () => {
  const ref = { owner: "zedu", repo: "web", number: 7 };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  };
  const graphqlUrl = "https://api.github.com/graphql";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function thread(login: string | null, isResolved: boolean) {
    return { isResolved, comments: { nodes: [{ author: login === null ? null : { login } }] } };
  }

  function page(nodes: unknown[], endCursor: string | null = null) {
    return {
      data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } } } },
    };
  }

  it("counts only unresolved threads CodeRabbit started", async () => {
    stubFetch((url) =>
      tokenRoute(url) ??
      (url === graphqlUrl
        ? jsonResponse(page([thread("coderabbitai", false), thread("coderabbitai", true), thread("ada", false), thread(null, false)]))
        : jsonResponse({}, false)),
    );

    await expect(createInstallationClient("123", env).unresolvedCodeRabbitThreads(ref)).resolves.toBe(1);
  });

  it("reads every page of threads", async () => {
    const fetchMock = stubFetch((url, init) => {
      const token = tokenRoute(url);
      if (token) return token;
      if (url !== graphqlUrl) return jsonResponse({}, false);
      const { variables } = JSON.parse(String(init?.body)) as { variables: { after: string | null } };
      return variables.after === null
        ? jsonResponse(page([thread("coderabbitai", false)], "next"))
        : jsonResponse(page([thread("coderabbitai", false)]));
    });

    await expect(createInstallationClient("123", env).unresolvedCodeRabbitThreads(ref)).resolves.toBe(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === graphqlUrl)).toHaveLength(2);
  });

  it("throws when GraphQL answers with errors, so the merge waits", async () => {
    stubFetch((url) => tokenRoute(url) ?? (url === graphqlUrl ? jsonResponse({ errors: [{ message: "nope" }] }) : jsonResponse({}, false)));

    await expect(createInstallationClient("123", env).unresolvedCodeRabbitThreads(ref)).rejects.toThrow();
  });

  it("throws when the request fails", async () => {
    stubFetch((url) => tokenRoute(url) ?? jsonResponse({}, false));

    await expect(createInstallationClient("123", env).unresolvedCodeRabbitThreads(ref)).rejects.toThrow();
  });
});

describe("failingChecks against the GitHub API: names what is not green, deployments included (#255)", () => {
  const ref = { owner: "zedu", repo: "web", number: 7 };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const json = (data: unknown, ok = true): Response =>
    ({ ok, status: ok ? 200 : 403, json: async () => data, headers: new Headers() }) as unknown as Response;

  type Routes = { checks?: unknown[]; statuses?: unknown[]; deployments?: unknown[] | "forbidden"; deploymentStatus?: unknown };
  function stub(routes: Routes) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/access_tokens")) return json({ token: "ghs_test" });
        if (url.includes("/check-runs")) return json({ check_runs: routes.checks ?? [], total_count: (routes.checks ?? []).length });
        if (url.endsWith("/status")) return json({ statuses: routes.statuses ?? [] });
        if (url.includes("/deployments?")) return routes.deployments === "forbidden" ? json({}, false) : json(routes.deployments ?? []);
        if (url.includes("/deployments/") && url.includes("/statuses")) return json([routes.deploymentStatus]);
        return json({}, false);
      }),
    );
  }
  const client = () => createInstallationClient("123", env);

  it("is empty when everything is green, and when nothing is deployed for the commit", async () => {
    stub({ checks: [{ name: "build", status: "completed", conclusion: "success" }] });
    await expect(client().failingChecks!(ref, "sha1")).resolves.toEqual([]);
  });

  it("names a failing check run with its link", async () => {
    stub({ checks: [{ name: "build", status: "completed", conclusion: "failure", html_url: "https://gh/run/1" }] });
    await expect(client().failingChecks!(ref, "sha1")).resolves.toEqual(['check "build": failure (https://gh/run/1)']);
  });

  it("names a failing Vercel commit status even when check runs exist", async () => {
    stub({
      checks: [{ name: "build", status: "completed", conclusion: "success" }],
      statuses: [{ context: "Vercel", state: "failure", description: "Deployment failed", target_url: "https://vercel.example/d/1" }],
    });
    await expect(client().failingChecks!(ref, "sha1")).resolves.toEqual([
      'status "Vercel": failure, Deployment failed (https://vercel.example/d/1)',
    ]);
  });

  it("names a deployment that failed, with its environment", async () => {
    stub({
      deployments: [{ id: 5, environment: "Production" }],
      deploymentStatus: { state: "failure", description: "Build failed", log_url: "https://vercel.example/log/5" },
    });
    await expect(client().failingChecks!(ref, "sha1")).resolves.toEqual([
      "deployment to Production: failure, Build failed (https://vercel.example/log/5)",
    ]);
  });

  it("counts a deployment that is still running as not green", async () => {
    stub({ deployments: [{ id: 5, environment: "Preview" }], deploymentStatus: { state: "in_progress" } });
    await expect(client().failingChecks!(ref, "sha1")).resolves.toEqual(["deployment to Preview: in_progress"]);
  });

  it("ignores a deployment that succeeded", async () => {
    stub({ deployments: [{ id: 5, environment: "Preview" }], deploymentStatus: { state: "success" } });
    await expect(client().failingChecks!(ref, "sha1")).resolves.toEqual([]);
  });

  it("skips deployments the app isn't allowed to read instead of failing everything", async () => {
    stub({ checks: [{ name: "build", status: "completed", conclusion: "success" }], deployments: "forbidden" });
    await expect(client().failingChecks!(ref, "sha1")).resolves.toEqual([]);
  });
});
