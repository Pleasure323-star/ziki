import { createSign } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/agents/audit";
import type { AgentContext } from "@/lib/agents/require-agent";
import { publish } from "@/lib/agent-api/events";
import { notifyMergeFailed } from "@/lib/agent-notifications";
import { checkApprovalOpen } from "@/lib/approvals";
import { workflowFor } from "@/lib/workflow";

/**
 * Merging the linked pull request after the tracker accepts a fix (#452).
 *
 * #434 records the acceptance on Ziki; it does not merge git. This module
 * merges the linked pull request through a GitHub App installation on the
 * project (`Project.githubInstallationId`) — never a personal access token.
 * Installation tokens are minted when needed and kept in memory only; nothing
 * is written to the database.
 *
 * The merge is attempted only when all of the gates hold: #434 accepted the
 * fix, the issue links a pull request that belongs to `Project.repoUrl`, the
 * pull request's checks are green, and the app can merge that repo. On failure
 * the tracker acceptance is left untouched, a `github.merge_failed` event is
 * published, and the claim's person is notified.
 */

// ---------------------------------------------------------------------------
// URL parsing (pure)
// ---------------------------------------------------------------------------

export type RepoRef = { owner: string; repo: string };
export type PullRequestRef = RepoRef & { number: number };

const GITHUB_HOST = "github.com";

/** Parse `https://github.com/owner/repo(.git)` or `git@github.com:owner/repo`. */
export function parseGitHubRepoUrl(url: string | null | undefined): RepoRef | null {
  if (!url) return null;
  const trimmed = url.trim();
  const scp = /^[^@\s]+@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed);
  if (scp) return { owner: scp[1], repo: scp[2] };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== GITHUB_HOST) return null;
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2) return null;
  const [owner, repoRaw] = parts;
  const repo = repoRaw.replace(/\.git$/i, "");
  if (!owner || !repo) return null;
  return { owner, repo };
}

/** Parse `https://github.com/owner/repo/pull/123` (trailing path ignored). */
export function parsePullRequestUrl(url: string | null | undefined): PullRequestRef | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== GITHUB_HOST) return null;
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(parsed.pathname);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/** True when two refs name the same repository (GitHub is case-insensitive). */
export function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}

// ---------------------------------------------------------------------------
// The GitHub client (real one, and the seam tests fake)
// ---------------------------------------------------------------------------

export type PullRequest = {
  merged: boolean;
  mergeable: boolean;
  headSha: string;
  state?: string;
  /** How many files the pull request changes, when GitHub says (Ziki #713). Zero means it is empty. */
  changedFiles?: number;
};

/** What GitHub answered the merge request (#492). */
export type MergePullResult = {
  merged: boolean;
  sha?: string;
  forbidden?: boolean;
  /** GitHub refused because the head moved since the checks were read. */
  conflict?: boolean;
  /** The repository allows no merge method the app can use. */
  noAllowedMethod?: boolean;
  /** Detailed error message from GitHub API response if available. */
  message?: string;
};

export interface GitHubClient {
  getPullRequest(ref: PullRequestRef): Promise<PullRequest>;
  checksGreen(ref: PullRequestRef, headSha: string): Promise<boolean>;
  /**
   * Everything on the head commit that is not green, named so the author knows
   * what to fix: check runs, commit statuses (Vercel and other deploy tools post
   * these) and deployments. Empty when all is green. Optional so a client that
   * only knows `checksGreen` still works.
   */
  failingChecks?(ref: PullRequestRef, headSha: string): Promise<string[]>;
  /** Merge `ref` pinned to `headSha`, the commit whose checks were verified. */
  mergePullRequest(ref: PullRequestRef, headSha: string): Promise<MergePullResult>;
  /** Review threads CodeRabbit started that are not resolved yet. Throws when they can't be read. */
  unresolvedCodeRabbitThreads(ref: PullRequestRef): Promise<number>;
  getPullRequestFiles?(ref: PullRequestRef): Promise<string[]>;
}

/** The login GitHub's GraphQL API reports for CodeRabbit's review comments. */
export const CODERABBIT_LOGIN = "coderabbitai";

/** Why a merge has to wait for CodeRabbit, with the number of open threads. */
export function codeRabbitThreadsMessage(count: number): string {
  const threads = count === 1 ? "1 unresolved review thread" : `${count} unresolved review threads`;
  return `CodeRabbit has ${threads} on this pull request. Resolve them before merging.`;
}

export const CHECKS_NOT_GREEN_MESSAGE =
  "GitHub Actions CI/CD checks or deployment runs have not passed for this pull request head commit.";

/** Why a fix can't be trusted not to break the code yet, and what its author has to do. */
export type FixBreakBlock = {
  missing: "pull_request" | "deployment_verification";
  message: string;
  todo: string;
};

/** True when GitHub reports the pull request can't merge into its base branch as it is. */
export function hasMergeConflicts(pullRequest: PullRequest): boolean {
  // A merged pull request is already in; GitHub no longer reports conflicts for it.
  return !pullRequest.merged && !pullRequest.mergeable;
}

// Whether a review thread is resolved is only available through GraphQL.
const REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first: 1) { nodes { author { login } } } }
      }
    }
  }
}`;

type ReviewThreadsPage = {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: { isResolved?: boolean; comments?: { nodes?: { author?: { login?: string } | null }[] } }[];
};

export class GitHubError extends Error {}

const GITHUB_API = "https://api.github.com";

/** base64url encode, the JWT segment encoding. */
function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function normalizePrivateKey(raw: string): string {
  let k = raw.trim();
  if (
    (k.startsWith('"') && k.endsWith('"')) ||
    (k.startsWith("'") && k.endsWith("'"))
  ) {
    k = k.slice(1, -1).trim();
  }
  // If base64 encoded PEM, decode it
  if (!k.includes("-----BEGIN") && /^[A-Za-z0-9+/=\s]+$/.test(k)) {
    try {
      const decoded = Buffer.from(k, "base64").toString("utf8");
      if (decoded.includes("-----BEGIN")) {
        k = decoded;
      }
    } catch {
      // not valid base64
    }
  }
  if (k.includes("\\n")) {
    k = k.replace(/\\n/g, "\n");
  }
  if (k.includes("\\r")) {
    k = k.replace(/\\r/g, "\r");
  }
  // If newlines inside the PEM body were stripped or collapsed into spaces, reformat it into standard PEM lines
  const pemMatch = k.match(/-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/);
  if (pemMatch) {
    const header = `-----BEGIN ${pemMatch[1]}-----`;
    const footer = `-----END ${pemMatch[1]}-----`;
    const body = pemMatch[2].replace(/\s+/g, "");
    const formattedBody = body.match(/.{1,64}/g)?.join("\n") || body;
    k = `${header}\n${formattedBody}\n${footer}\n`;
  }
  return k;
}

/**
 * Sign the short-lived app JWT GitHub wants when minting an installation
 * token: RS256, `iss` is the app id, and it may live at most 10 minutes.
 */
export function createAppJwt(appId: string, privateKey: string, now: number = Date.now()): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const iat = Math.floor(now / 1000) - 60;
  const payload = base64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const keyToSign = normalizePrivateKey(privateKey);
  if (!keyToSign.includes("-----BEGIN")) {
    throw new GitHubError(
      `GitHub App private key signing failed: The configured key is ${privateKey.trim().length} characters long and is missing the '-----BEGIN ... PRIVATE KEY-----' header. Ensure GITHUB_APP_PRIVATE_KEY contains the contents of the downloaded .pem file, not the GitHub App Client Secret.`
    );
  }
  let signature: Buffer;
  try {
    signature = signer.sign(keyToSign);
  } catch (err) {
    throw new GitHubError(`GitHub App private key signing failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return `${signingInput}.${signature.toString("base64url")}`;
}

/**
 * A client for one installation. The installation token is minted on first use
 * and cached in memory for the life of the client; it is never persisted.
 */
export function createInstallationClient(
  installationId: string,
  env: NodeJS.ProcessEnv = process.env,
): GitHubClient {
  let token: string | null = null;

  async function installationToken(): Promise<string> {
    if (token) return token;
    const appId = env.GITHUB_APP_ID;
    const privateKey = env.GITHUB_APP_PRIVATE_KEY;
    if (!appId || !privateKey) throw new GitHubError("The GitHub App is not configured.");
    const response = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${createAppJwt(appId, privateKey)}`,
        accept: "application/vnd.github+json",
        "user-agent": "ziki-issues",
      },
    });
    if (!response.ok) {
      const errBody = (await response.json().catch(() => null)) as { message?: string } | null;
      const detail = errBody?.message ? `: ${errBody.message}` : ` (HTTP ${response.status})`;
      throw new GitHubError(`Could not mint an installation token${detail}.`);
    }
    const body = (await response.json()) as { token?: string };
    if (!body.token) throw new GitHubError("GitHub returned no installation token.");
    token = body.token;
    return token;
  }

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const value = await installationToken();
    return fetch(`${GITHUB_API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${value}`,
        accept: "application/vnd.github+json",
        "user-agent": "ziki-issues",
        ...(init?.headers ?? {}),
      },
    });
  }

  return {
    async getPullRequest(ref) {
      const response = await request(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
      if (!response.ok) {
        const errBody = (await response.json().catch(() => null)) as { message?: string } | null;
        const detail = errBody?.message ? `: ${errBody.message}` : ` (HTTP ${response.status})`;
        throw new GitHubError(`Could not read the pull request${detail}.`);
      }
      const body = (await response.json()) as {
        state?: string;
        merged?: boolean;
        mergeable?: boolean;
        changed_files?: number;
        head?: { sha?: string };
      };
      return {
        state: body.state,
        merged: !!body.merged,
        mergeable: body.mergeable !== false,
        ...(typeof body.changed_files === "number" ? { changedFiles: body.changed_files } : {}),
        headSha: body.head?.sha ?? "",
      };
    },
    async checksGreen(ref, headSha) {
      // Every check run on the head commit has to be read (#491). GitHub
      // pages check runs 30 at a time by default; a failing run past the
      // first page used to stay invisible while the gate passed.
      const runs: { status?: string; conclusion?: string | null }[] = [];
      for (let page = 1; ; page += 1) {
        const response = await request(
          `/repos/${ref.owner}/${ref.repo}/commits/${headSha}/check-runs?per_page=100&page=${page}`,
        );
        // Fail closed (#531): a refused or failed page (403 without
        // checks:read, 5xx, a secondary rate limit) means the runs are
        // unknown, not absent, so the gate must not pass on what it has.
        if (!response.ok) return false;
        const body = (await response.json()) as {
          check_runs?: { status?: string; conclusion?: string | null }[];
          total_count?: number;
        };
        const batch = body.check_runs ?? [];
        runs.push(...batch);
        if (batch.length < 100 || runs.length >= (body.total_count ?? runs.length)) break;
      }
      if (runs.length) {
        // Fail closed (#491): anything still queued or in progress, failed or
        // cancelled, is not green. Only completed runs with a passing
        // conclusion pass.
        return runs.every(
          (run) =>
            run.status === "completed" &&
            (run.conclusion === "success" || run.conclusion === "neutral" || run.conclusion === "skipped"),
        );
      }
      // No check runs: fall back to commit statuses. No statuses at all means
      // the repository has no required checks, so the gate holds. A "pending"
      // state while statuses exist means a check is still running — that is
      // not green (#491).
      const status = await request(`/repos/${ref.owner}/${ref.repo}/commits/${headSha}/status`);
      if (!status.ok) return false;
      const body = (await status.json()) as { state?: string; statuses?: unknown[] };
      const statuses = body.statuses ?? [];
      if (!statuses.length && (body.state === undefined || body.state === "pending")) return true;
      return body.state === "success";
    },
    async failingChecks(ref, headSha) {
      const failing: string[] = [];
      const withLink = (text: string, link?: string | null) => (link ? `${text} (${link})` : text);

      // 1. Check runs (GitHub Actions and other apps). Anything not completed
      // with a passing conclusion is named; an unreadable page is a failure,
      // not an absence (#531).
      const runs: { name?: string; status?: string; conclusion?: string | null; html_url?: string | null }[] = [];
      for (let page = 1; ; page += 1) {
        const response = await request(
          `/repos/${ref.owner}/${ref.repo}/commits/${headSha}/check-runs?per_page=100&page=${page}`,
        );
        if (!response.ok) return ["GitHub could not be asked for the check runs on this commit"];
        const body = (await response.json()) as { check_runs?: typeof runs; total_count?: number };
        const batch = body.check_runs ?? [];
        runs.push(...batch);
        if (batch.length < 100 || runs.length >= (body.total_count ?? runs.length)) break;
      }
      for (const run of runs) {
        const passed =
          run.status === "completed" &&
          (run.conclusion === "success" || run.conclusion === "neutral" || run.conclusion === "skipped");
        if (passed) continue;
        const state = run.status === "completed" ? `${run.conclusion ?? "did not pass"}` : `still ${run.status ?? "running"}`;
        failing.push(withLink(`check "${run.name ?? "unnamed"}": ${state}`, run.html_url));
      }

      // 2. Commit statuses. Vercel and other deploy tools report a deployment
      // here, and they are not check runs, so they were never looked at once a
      // repository had any check run.
      const status = await request(`/repos/${ref.owner}/${ref.repo}/commits/${headSha}/status`);
      if (!status.ok) {
        failing.push("GitHub could not be asked for the commit statuses");
      } else {
        const body = (await status.json()) as {
          statuses?: { context?: string; state?: string; description?: string | null; target_url?: string | null }[];
        };
        for (const item of body.statuses ?? []) {
          if (item.state === "success") continue;
          const why = item.description ? `${item.state}, ${item.description}` : `${item.state}`;
          failing.push(withLink(`status "${item.context ?? "unnamed"}": ${why}`, item.target_url));
        }
      }

      // 3. Deployments of this commit. A deployment the app can't read (no
      // deployments permission) is skipped; its status or check run above
      // covers the common tools.
      const deployments = await request(`/repos/${ref.owner}/${ref.repo}/deployments?sha=${headSha}&per_page=10`);
      if (deployments.ok) {
        const list = (await deployments.json()) as { id: number; environment?: string }[];
        for (const deployment of list ?? []) {
          const latest = await request(
            `/repos/${ref.owner}/${ref.repo}/deployments/${deployment.id}/statuses?per_page=1`,
          );
          if (!latest.ok) continue;
          const [first] = (await latest.json()) as {
            state?: string;
            description?: string | null;
            log_url?: string | null;
            target_url?: string | null;
          }[];
          if (!first || first.state === "success" || first.state === "inactive") continue;
          const where = deployment.environment ?? "an environment";
          const why = first.description ? `${first.state}, ${first.description}` : `${first.state}`;
          failing.push(withLink(`deployment to ${where}: ${why}`, first.log_url ?? first.target_url));
        }
      }
      return failing;
    },
    async mergePullRequest(ref, headSha) {
      // Squash is not universally allowed (#492): ask the repository which
      // methods it accepts and prefer squash, then a merge commit, then
      // rebase. If the settings can't be read, keep the old squash default.
      let method: string | null = "squash";
      const repo = await request(`/repos/${ref.owner}/${ref.repo}`);
      if (repo.ok) {
        const body = (await repo.json()) as {
          allow_squash_merge?: boolean;
          allow_merge_commit?: boolean;
          allow_rebase_merge?: boolean;
        };
        const hasKnownSettings =
          typeof body.allow_squash_merge === "boolean" ||
          typeof body.allow_merge_commit === "boolean" ||
          typeof body.allow_rebase_merge === "boolean";
        if (hasKnownSettings) {
          method = body.allow_squash_merge
            ? "squash"
            : body.allow_merge_commit
              ? "merge"
              : body.allow_rebase_merge
                ? "rebase"
                : null;
        }
      }
      if (!method) return { merged: false, noAllowedMethod: true };
      // Pinning `sha` (#492): GitHub then refuses with 409 when the head has
      // moved since the checks were read, so unreviewed commits never merge.
      const response = await request(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/merge`, {
        method: "PUT",
        body: JSON.stringify({ merge_method: method, sha: headSha }),
      });
      const errBody = !response.ok ? ((await response.json().catch(() => null)) as { message?: string } | null) : null;
      if (response.status === 403) return { merged: false, forbidden: true, message: errBody?.message };
      if (response.status === 405) return { merged: false, noAllowedMethod: true, message: errBody?.message };
      if (response.status === 409) return { merged: false, conflict: true, message: errBody?.message };
      if (!response.ok) return { merged: false, message: errBody?.message };
      const body = (await response.json()) as { merged?: boolean; sha?: string };
      return { merged: !!body.merged, sha: body.sha };
    },
    async unresolvedCodeRabbitThreads(ref) {
      // A thread is CodeRabbit's when CodeRabbit wrote its first comment.
      // Fail closed: a page that can't be read throws, and the merge waits.
      let open = 0;
      let after: string | null = null;
      for (;;) {
        const response = await request("/graphql", {
          method: "POST",
          body: JSON.stringify({
            query: REVIEW_THREADS_QUERY,
            variables: { owner: ref.owner, repo: ref.repo, number: ref.number, after },
          }),
        });
        if (!response.ok) throw new GitHubError("Could not read the pull request's review threads.");
        const body = (await response.json()) as {
          errors?: unknown[];
          data?: { repository?: { pullRequest?: { reviewThreads?: ReviewThreadsPage } | null } | null };
        };
        const page = body.data?.repository?.pullRequest?.reviewThreads;
        if (body.errors?.length || !page) throw new GitHubError("Could not read the pull request's review threads.");
        for (const thread of page.nodes ?? []) {
          const author = thread.comments?.nodes?.[0]?.author?.login?.toLowerCase() ?? "";
          if (!thread.isResolved && author.startsWith(CODERABBIT_LOGIN)) open += 1;
        }
        if (!page.pageInfo?.hasNextPage) return open;
        after = page.pageInfo.endCursor ?? null;
        if (!after) throw new GitHubError("Could not read the pull request's review threads.");
      }
    },
  };
}

/** The client for a project's GitHub App installation, when it has one (#489). */
export function clientForInstallation(installationId: string | null | undefined, env?: NodeJS.ProcessEnv): GitHubClient | null {
  if (!installationId) return null;
  try {
    return createInstallationClient(installationId, env);
  } catch {
    return null;
  }
}

/** True when `pullRequestUrl` names a PR on GitHub that was closed without merging (#642). */
export async function isPullRequestClosedUnmerged(
  pullRequestUrl: string | null | undefined,
  githubInstallationId?: string | null,
  client?: GitHubClient | null,
): Promise<boolean> {
  const ref = parsePullRequestUrl(pullRequestUrl);
  if (!ref) return false;
  const gh = client ?? clientForInstallation(githubInstallationId);
  if (!gh) return false;
  try {
    const pr = await gh.getPullRequest(ref);
    return pr.state === "closed" && !pr.merged;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The gated merge
// ---------------------------------------------------------------------------

export type MergeFailureReason =
  | "not_found"
  | "not_accepted"
  | "no_pull_request"
  | "repo_mismatch"
  | "pull_request_changed"
  | "checks_failed"
  | "review_threads"
  | "head_moved"
  | "no_permission"
  | "merge_failed"
  | "waiting_for_human"
  | "auto_merge_disabled";

export type MergeResult =
  | { status: 200; merged: true; mergeCommitSha: string; pullRequestUrl: string }
  | { status: 403 | 404 | 409 | 422; merged: false; reason: MergeFailureReason; message: string; approvalId?: string };

export type MergeDeps = {
  /** Injected in tests; the real client is built from the project's installation. */
  client?: GitHubClient;
  db?: PrismaClient;
  env?: NodeJS.ProcessEnv;
  files?: string[];
};

const mergeBugSelect = {
  id: true,
  title: true,
  tenantId: true,
  projectId: true,
  pullRequestUrl: true,
  assigneeId: true,
  project: { select: { repoUrl: true, githubInstallationId: true } },
  claims: {
    where: { status: "active", releasedAt: null },
    select: { beneficiaryUserId: true },
    take: 1,
  },
} as const;

type LoadedBug = {
  id: string;
  title: string;
  tenantId: string;
  projectId: string;
  pullRequestUrl: string | null;
  assigneeId: string | null;
  project: { repoUrl: string | null; githubInstallationId: string | null } | null;
  claims: { beneficiaryUserId: string }[];
};

function fail(
  status: 403 | 404 | 409 | 422,
  reason: MergeFailureReason,
  message: string,
): MergeResult {
  return { status, merged: false, reason, message };
}

/**
 * Publish `github.merge_failed`, record it, and tell the claim's person. The
 * tracker acceptance (`status`, points) is never touched here.
 */
async function recordMergeFailure(
  agent: AgentContext,
  bug: LoadedBug,
  reason: string,
  db: PrismaClient,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await publish(tx, {
      tenantId: bug.tenantId,
      type: "github.merge_failed",
      payload: { issueId: bug.id, reason, pullRequestUrl: bug.pullRequestUrl },
      actorAgentId: agent.agentId,
      bugId: bug.id,
    });
    await audit(agent, "github.merge_failed", `bug:${bug.id}`, { reason }, { bugId: bug.id, db: tx });
  });
  const recipient = bug.claims[0]?.beneficiaryUserId ?? bug.assigneeId ?? null;
  if (recipient) {
    notifyMergeFailed({
      bugId: bug.id,
      bugTitle: bug.title,
      recipientId: recipient,
      reason,
      agent: { name: agent.name },
    });
  }
}

/**
 * The `issue.accepted` audit row that still stands for an issue (#490).
 *
 * Acceptance lives on the audit row rather than on `Bug.status`, so this is
 * the single test for "a merger accepted this fix". A tenant admin undo
 * (#450) stamps `undoneAt`; an undone acceptance must not gate anything.
 *
 * The payload carries what was accepted (#489): the pull request and its
 * head commit at the time, so a different PR — or new commits — can't merge.
 */
export async function standingAcceptance(
  db: PrismaClient,
  bugId: string,
): Promise<{ id: string; payload: unknown } | null> {
  return db.agentAuditEvent.findFirst({
    where: { bugId, action: "issue.accepted", undoneAt: null },
    select: { id: true, payload: true },
  });
}

/** What `acceptFix` recorded on the acceptance row (#489). */
export type AcceptedFix = { pullRequestUrl?: string; headSha?: string | null };

function acceptedFixOf(accepted: { payload: unknown } | null): AcceptedFix {
  const payload = accepted?.payload;
  if (!payload || typeof payload !== "object") return {};
  const { pullRequestUrl, headSha } = payload as { pullRequestUrl?: unknown; headSha?: unknown };
  return {
    ...(typeof pullRequestUrl === "string" ? { pullRequestUrl } : {}),
    ...(typeof headSha === "string" ? { headSha } : {}),
  };
}

/**
 * Merge the accepted fix's linked pull request (#452). See the module comment
 * for the gates. Success records the merge commit sha on the `github.merged`
 * audit event and returns it.
 */
export async function mergeAcceptedFix(
  agent: AgentContext,
  bugId: string,
  deps: MergeDeps = {},
): Promise<MergeResult> {
  const db = deps.db ?? prisma;

  const bug = (await db.bug.findFirst({
    where: { id: bugId, tenantId: agent.tenantId, isDeleted: false },
    select: mergeBugSelect,
  })) as LoadedBug | null;
  if (!bug) return fail(404, "not_found", "No such issue in this agent's tenant.");

  // Gate 1: #434 accepted the fix. Gate on its audit row, not on `status`,
  // which a person can also set by resolving the issue. A tenant admin's undo
  // (#450) stamps `undoneAt` on that row; an undone acceptance gates nothing.
  const accepted = await standingAcceptance(db, bug.id);
  if (!accepted) {
    return fail(409, "not_accepted", "The fix has not been accepted on the tracker yet.");
  }

  // Gate 1b (#489): the acceptance names the pull request that was reviewed.
  // If the issue now links a different one, the fix was swapped after
  // acceptance — refuse, and merge nothing.
  const acceptedFix = acceptedFixOf(accepted);
  if (
    acceptedFix.pullRequestUrl &&
    bug.pullRequestUrl &&
    acceptedFix.pullRequestUrl !== bug.pullRequestUrl
  ) {
    return fail(
      409,
      "pull_request_changed",
      "This issue's accepted fix is bound to a different pull request — link the accepted one again.",
    );
  }

  // Gate 1c (#595): a project can turn automatic GitHub merging off. Tracker
  // acceptance still records the fix; a person merges the pull request.
  const workflow = await workflowFor(bug.projectId, db);
  if (!workflow.autoMerge) {
    return fail(
      409,
      "auto_merge_disabled",
      "Automatic merging is off for this project; a person must merge the pull request.",
    );
  }

  // Gate 2: the issue links a pull request that belongs to the project's repo.
  const ref = parsePullRequestUrl(bug.pullRequestUrl);
  if (!ref) return fail(409, "no_pull_request", "No pull request is linked to this issue.");
  const repo = parseGitHubRepoUrl(bug.project?.repoUrl);
  if (!repo || !sameRepo(ref, repo)) {
    return fail(422, "repo_mismatch", "That pull request is not in this project's repository.");
  }

  const client = deps.client ?? clientForInstallation(bug.project?.githubInstallationId, deps.env);
  let prFiles = deps.files ?? [];
  if (!prFiles.length && client?.getPullRequestFiles) {
    try {
      prFiles = await client.getPullRequestFiles(ref);
    } catch {
      // Non-fatal if files cannot be read
    }
  }

  const approvalCheck = await checkApprovalOpen(bug.id, "before_merge", {
    db: db as never,
    files: prFiles,
    agent,
  });
  if (!approvalCheck.allowed) {
    return {
      status: 409,
      merged: false,
      reason: "waiting_for_human",
      approvalId: approvalCheck.approvalId,
      message: "Human approval required before merge.",
    };
  }
  if (!client) {
    await recordMergeFailure(agent, bug, "The app is not installed on this repository.", db);
    return fail(403, "no_permission", "The app is not allowed to merge this repository.");
  }

  let pullRequest: PullRequest;
  try {
    pullRequest = await client.getPullRequest(ref);
  } catch (error) {
    const detail = error instanceof Error && error.message ? error.message : "GitHub could not be reached.";
    const message = detail.startsWith("GitHub could not be reached") ? detail : `GitHub could not be reached: ${detail}`;
    await recordMergeFailure(agent, bug, message, db);
    return fail(409, "merge_failed", message);
  }

  // Gate 2a (#642): a pull request closed without merging cannot be merged.
  if (pullRequest.state === "closed" && !pullRequest.merged) {
    await recordMergeFailure(agent, bug, "The pull request is closed without being merged.", db);
    return fail(409, "merge_failed", "The pull request is closed without being merged.");
  }

  // Gate 2b (#489): the head commit GitHub reports must be the one that was
  // accepted. Commits pushed after acceptance were never reviewed by the
  // acceptance, so the merge stays blocked until the fix is re-verified.
  if (acceptedFix.headSha && pullRequest.headSha && acceptedFix.headSha !== pullRequest.headSha) {
    await recordMergeFailure(agent, bug, "The pull request changed after the fix was accepted.", db);
    return fail(
      409,
      "head_moved",
      "The accepted pull request's head commit changed since acceptance — verify the new commits before merging.",
    );
  }

  // Gate 3: the pull request's required checks are green.
  let green: boolean;
  try {
    green = await client.checksGreen(ref, pullRequest.headSha);
  } catch {
    await recordMergeFailure(agent, bug, "GitHub could not be reached.", db);
    return fail(409, "merge_failed", "GitHub could not be reached.");
  }
  if (!green) {
    await recordMergeFailure(agent, bug, "The pull request's checks are not green.", db);
    return fail(409, "checks_failed", "The pull request's required checks are not green.");
  }

  // Gate 3b: every review thread CodeRabbit opened is resolved.
  let openThreads: number;
  try {
    openThreads = await client.unresolvedCodeRabbitThreads(ref);
  } catch {
    await recordMergeFailure(agent, bug, "GitHub could not be reached to read CodeRabbit's review threads.", db);
    return fail(409, "merge_failed", "GitHub could not be reached to read CodeRabbit's review threads.");
  }
  if (openThreads > 0) {
    await recordMergeFailure(agent, bug, codeRabbitThreadsMessage(openThreads), db);
    return fail(409, "review_threads", codeRabbitThreadsMessage(openThreads));
  }

  // Gate 4: the app has permission to merge that repo. The merge is pinned to
  // the head SHA whose checks were verified (#492).
  let merged: MergePullResult;
  try {
    merged = await client.mergePullRequest(ref, pullRequest.headSha);
  } catch {
    await recordMergeFailure(agent, bug, "GitHub could not be reached.", db);
    return fail(409, "merge_failed", "GitHub could not be reached.");
  }
  if (merged.forbidden) {
    await recordMergeFailure(agent, bug, "The app is not allowed to merge this repository.", db);
    return fail(403, "no_permission", "The app is not allowed to merge this repository.");
  }
  if (merged.conflict) {
    await recordMergeFailure(agent, bug, "The pull request changed after its checks were verified.", db);
    return fail(
      409,
      "head_moved",
      "The pull request's head commit changed since its checks were verified — link it again and verify the new commits.",
    );
  }
  if (merged.noAllowedMethod) {
    await recordMergeFailure(agent, bug, "The repository allows no merge method the app can use.", db);
    return fail(
      422,
      "merge_failed",
      "This repository allows no merge method the app can use. Enable squash, merge or rebase merges for it on GitHub.",
    );
  }
  if (!merged.merged) {
    await recordMergeFailure(agent, bug, "GitHub refused the merge.", db);
    return fail(409, "merge_failed", "GitHub refused the merge.");
  }

  const mergeCommitSha = merged.sha ?? pullRequest.headSha;
  await audit(
    agent,
    "github.merged",
    `bug:${bug.id}`,
    { mergeCommitSha, pullRequestUrl: bug.pullRequestUrl },
    { bugId: bug.id, db },
  );
  return {
    status: 200,
    merged: true,
    mergeCommitSha,
    pullRequestUrl: bug.pullRequestUrl ?? "",
  };
}
