import type { AgentLevel, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { hasLevel, requireLevel } from "@/lib/agents/levels";
import { reviewerConflict, ReviewerNotIndependentError } from "@/lib/agents/independence";
import { IssueApiError } from "@/lib/agent-api/errors";
import { cursorOrderBy, cursorWhere, decodeCursor, MAX_PAGE_SIZE, toPage, type IssueCursor } from "@/lib/agent-api/create-policy";
import { deliveredClaim } from "@/lib/agent-api/merge-verdicts";
import { countJudgements, judgedBugSelect, judgementSelect, type Judgement } from "@/lib/agent-api/tested-status";
import { strandedDelivery, type StrandedDelivery } from "@/lib/agent-api/stranded-delivery";
import { idleInProgress } from "@/lib/agent-api/idle";
import { staleHold, type StaleHold } from "@/lib/agent-api/stale-hold";
import { currentHold, type IssueHold } from "@/lib/issue-holders";
import { OPEN_BID_WHERE } from "@/lib/open-bids";
import { isThresholdOnly } from "@/lib/governance";
import { workflowFor } from "@/lib/workflow";
import { isFormerNameOf } from "@/lib/github/former-repos";
import {
  commitInBranch,
  configuredClientFor,
  GitHubError,
  parseGitHubRepoUrl,
  parsePullRequestUrl,
  sameRepo,
  type GitHubClient,
  type PullRequest,
  type PullRequestRef,
  type RepoRef,
} from "@/lib/github/merge-pr";
import { absoluteUrl } from "@/lib/site-url";
import { issuePath } from "@/lib/issue-ref";

/**
 * The manager's triage view (#triage): one read that says, for every issue in
 * the project that is moving, where it stands and what the caller may do next.
 *
 * A manager on production had to open each issue, its test verdicts and its
 * pull request on GitHub separately to decide what to do. This puts them in
 * one list: every issue In progress, Delivered, Done or Ready to Merge, and
 * every Open issue with open bids, each with
 *
 * - who holds it (the claim, `lib/issue-holders.ts`), and whether an Open
 *   issue's assignee is stale;
 * - its pull request: whether the link points at the project's repository
 *   (`linkState`), and from GitHub its state, the branch it was merged into
 *   and whether the default branch contains it;
 * - its judgements on the linked pull request (the Delivered step's count);
 * - its open bids;
 * - `nextActions`: what the caller may do now, under the same rules the write
 *   routes enforce, each with `canAct` and, when blocked, why.
 *
 * It only reads. GitHub is asked through the project's GitHub App, at most
 * `GITHUB_CONCURRENCY` requests at a time, and each pull request's answer is
 * kept for `PR_CACHE_MS`. Without the App, `linkState` comes from the URL
 * alone and `state` is "unknown".
 */

/** The statuses triage lists (and Open issues with open bids). */
export const TRIAGE_STATUSES = ["in_progress", "delivered", "done", "ready_to_merge"] as const;

export const TRIAGE_DEFAULT_LIMIT = 50;
/** How long a pull request's GitHub answer is reused. */
export const PR_CACHE_MS = 5 * 60_000;
/** GitHub requests in flight at once. */
export const GITHUB_CONCURRENCY = 4;

/**
 * How an issue's pull request link relates to the project's repository.
 * `ok`: in it. `old_repository`: under a former name of it (repair the link).
 * `other_repository`: somewhere else, or not a pull request address.
 * `missing`: no link. `not_found`: in it, but GitHub answers 404.
 * `unknown`: the project names no repository to compare with.
 */
export type LinkState = "ok" | "old_repository" | "other_repository" | "missing" | "not_found" | "unknown";

export type TriagePullRequest = {
  url: string | null;
  linkState: LinkState;
  state: "open" | "closed" | "merged" | "unknown";
  /** The branch it was merged into, once merged. */
  mergedInto: string | null;
  /** The repository's default branch, when GitHub said. */
  defaultBranch: string | null;
  /** Merged and contained in the default branch; null when not merged or unknown. */
  inDefaultBranch: boolean | null;
  headSha: string | null;
  mergeCommitSha: string | null;
  /** For a link outside the project's repository: whether the same number exists in it (null when not asked). */
  sameNumberInProjectRepo: boolean | null;
};

export type TriageHolder = {
  state: "active_claim" | "live_offer" | "none";
  agentName: string | null;
  personName: string | null;
  via: IssueHold["via"] | null;
  offeredAt: string | null;
  claimedAt: string | null;
  assignee: { id: string; name: string | null } | null;
  /** An Open issue's assignee with no active claim or live offer behind it (#stale-assignee). */
  staleAssignee: boolean;
};

export type TriageAction = {
  action: string;
  method: "POST";
  route: string;
  minimumRole: AgentLevel;
  canAct: boolean;
  blockedReason?: string;
  /** Something to know before acting. */
  note?: string;
};

export type TriageItem = {
  issue: { id: string; number: number; title: string; status: string; url: string };
  holder: TriageHolder;
  pullRequest: TriagePullRequest;
  /** Judgements on the linked pull request; null with no pull request. */
  judgements: { good: number; notGood: number; needed: number; goodAtHead: number | null; headSha: string | null } | null;
  /** Open bids on an Open issue; null otherwise. */
  bids: { open: number } | null;
  nextActions: TriageAction[];
};

export type TriagePage = { items: TriageItem[]; nextCursor: string | null; githubAvailable: boolean };

// ---------------------------------------------------------------------------
// The pull request link, without GitHub
// ---------------------------------------------------------------------------

/** `linkState` from the URL and the project's repository alone. */
export function linkStateFromUrl(pullRequestUrl: string | null | undefined, repo: RepoRef | null): LinkState {
  if (!pullRequestUrl) return "missing";
  if (!repo) return "unknown";
  const ref = parsePullRequestUrl(pullRequestUrl);
  if (!ref) return "other_repository";
  if (sameRepo(ref, repo)) return "ok";
  return isFormerNameOf(ref, repo) ? "old_repository" : "other_repository";
}

// ---------------------------------------------------------------------------
// GitHub, cached
// ---------------------------------------------------------------------------

type PrLookup = { found: true; pr: PullRequest } | { found: false };
const prCache = new Map<string, { at: number; value: PrLookup }>();
const containsCache = new Map<string, { at: number; value: boolean }>();

/** For tests. */
export function clearTriageCache(): void {
  prCache.clear();
  containsCache.clear();
}

/** The pull request from GitHub, cached; `found: false` on 404, null when GitHub didn't answer. */
async function lookupPullRequest(client: GitHubClient, ref: PullRequestRef, now: number): Promise<PrLookup | null> {
  const key = `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`.toLowerCase();
  const hit = prCache.get(key);
  if (hit && now - hit.at < PR_CACHE_MS) return hit.value;
  let value: PrLookup;
  try {
    value = { found: true, pr: await client.getPullRequest(ref) };
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) return null;
    value = { found: false };
  }
  prCache.set(key, { at: now, value });
  return value;
}

/** Whether `branch` contains `sha`, cached; null when unknown. */
async function branchContains(client: GitHubClient, repo: RepoRef, branch: string, sha: string, now: number): Promise<boolean | null> {
  const key = `${repo.owner}/${repo.repo}:${branch}...${sha}`.toLowerCase();
  const hit = containsCache.get(key);
  if (hit && now - hit.at < PR_CACHE_MS) return hit.value;
  let value: boolean | null;
  try {
    value = await commitInBranch(client, repo, branch, sha);
  } catch {
    return null;
  }
  if (value === null) return null;
  containsCache.set(key, { at: now, value });
  return value;
}

/** Everything triage says about one pull request link. */
export async function pullRequestFacts(
  url: string | null,
  repo: RepoRef | null,
  client: GitHubClient | null,
  now = Date.now(),
): Promise<TriagePullRequest> {
  const base: TriagePullRequest = {
    url,
    linkState: linkStateFromUrl(url, repo),
    state: "unknown",
    mergedInto: null,
    defaultBranch: null,
    inDefaultBranch: null,
    headSha: null,
    mergeCommitSha: null,
    sameNumberInProjectRepo: null,
  };
  const ref = parsePullRequestUrl(url);
  if (!client || !repo || !ref) return base;
  // A link under an old name is the same pull request in the project's
  // repository (GitHub redirects a renamed one); for one elsewhere, triage
  // only asks whether that number exists here, for the repair.
  const lookup = await lookupPullRequest(client, { ...repo, number: ref.number }, now);
  if (lookup === null) return base;
  if (!lookup.found) {
    return { ...base, linkState: base.linkState === "ok" ? "not_found" : base.linkState, sameNumberInProjectRepo: base.linkState === "ok" ? null : false };
  }
  if (base.linkState === "other_repository") return { ...base, sameNumberInProjectRepo: true };

  const pr = lookup.pr;
  const state = pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open";
  const mergedInto = pr.merged ? pr.baseRef ?? null : null;
  const defaultBranch = pr.defaultBranch ?? null;
  const mergeCommitSha = pr.merged ? pr.mergeCommitSha ?? null : null;
  let inDefaultBranch: boolean | null = null;
  if (pr.merged && mergedInto && defaultBranch) {
    inDefaultBranch = mergedInto === defaultBranch
      ? true
      : mergeCommitSha
        ? await branchContains(client, repo, defaultBranch, mergeCommitSha, now)
        : null;
  }
  return {
    ...base,
    state,
    mergedInto,
    defaultBranch,
    inDefaultBranch,
    headSha: pr.headSha || null,
    mergeCommitSha,
    sameNumberInProjectRepo: base.linkState === "old_repository" ? true : null,
  };
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// What the caller may do: one pure rule over facts already read
// ---------------------------------------------------------------------------

export type TriageCaller = { agentId: string; ownerId: string; level: AgentLevel };

export type TriageFacts = {
  bug: Prisma.BugGetPayload<{ select: typeof triageBugSelect }>;
  projectId: string;
  repo: RepoRef | null;
  thresholdOnly: boolean;
  pullRequest: TriagePullRequest;
  judgements: TriageItem["judgements"];
  /** Open bids, most voted first: the bid id, its votes and the owners it is from. */
  bids: { id: string; votes: number; ownerIds: string[] }[];
  hold: IssueHold | null;
  stranded: StrandedDelivery | null;
  /** Idle In progress work: whether a claim holds it, and its holder's owners. */
  idle: { held: boolean; holderOwners: string[]; idleHours: number } | null;
  stale: StaleHold["kind"] | null;
  /** The caller's owner already judged the linked pull request. */
  judgedByCaller: boolean;
};

const STALE_WHY: Record<StaleHold["kind"], string> = {
  offer_expired: "its offer was not accepted within the offer window",
  overdue: "its work was not delivered by the deadline",
  silent: "its agent stopped checking in and has delivered nothing",
};

/** The actions the caller may take on one issue now, with why each blocked one is blocked. */
export function nextActions(caller: TriageCaller, facts: TriageFacts): TriageAction[] {
  const { bug, pullRequest: pr, projectId } = facts;
  const actions: TriageAction[] = [];
  const route = (tail: string) => `/api/v1/issues/${bug.id}/${tail}?projectId=${projectId}`;
  const conflict = reviewerConflict({ id: caller.agentId, ownerUserId: caller.ownerId }, bug);
  const notIndependent = conflict ? `Not independent: ${new ReviewerNotIndependentError(conflict).message}` : null;
  const gate = (role: AgentLevel, why: (string | null | undefined)[] = [], independence = true): Pick<TriageAction, "canAct" | "blockedReason"> => {
    if (!hasLevel(caller.level, role)) return { canAct: false, blockedReason: `Needs a ${role} agent.` };
    if (independence && notIndependent) return { canAct: false, blockedReason: notIndependent };
    const first = why.find((reason): reason is string => Boolean(reason));
    return first ? { canAct: false, blockedReason: first } : { canAct: true };
  };
  const push = (action: string, path: string, minimumRole: AgentLevel, result: Pick<TriageAction, "canAct" | "blockedReason">, note?: string) => {
    actions.push({ action, method: "POST", route: path, minimumRole, ...result, ...(note ? { note } : {}) });
  };
  const repoName = facts.repo ? `${facts.repo.owner}/${facts.repo.repo}` : "the project's repository";
  const ref = parsePullRequestUrl(pr.url);

  // Why a pull request can't be accepted or merged as linked.
  const linkProblem =
    pr.linkState === "old_repository" ? "The PR link uses an old repository name: repair it first."
      : pr.linkState === "other_repository" ? `The PR link is not in ${repoName}.`
        : pr.linkState === "not_found" ? "The PR returns 404."
          : pr.linkState === "missing" ? "No pull request is linked."
            : null;

  // 1. A link to repair.
  if (bug.status !== "open" && (pr.linkState === "old_repository" || pr.linkState === "other_repository" || pr.linkState === "not_found")) {
    const number = ref ? `#${ref.number}` : "That number";
    const noSameNumber = pr.linkState === "not_found"
      ? `The PR returns 404: the author must submit a new PR in ${repoName}.`
      : pr.sameNumberInProjectRepo === false
        ? `PR ${number} doesn't exist in ${repoName}: the author must submit a new PR.`
        : null;
    const note = pr.linkState === "other_repository" && !noSameNumber
      ? `The link points outside ${repoName}; check that ${number} there is the same work, or send pullRequestUrl.`
      : pr.sameNumberInProjectRepo === null && !noSameNumber
        ? "GitHub wasn't asked; the route checks that the pull request exists."
        : undefined;
    push("repair_pull_request", route("pull-request"), "manager", gate("manager", [noSameNumber]), note);
  }

  // 2. Merged already: reconcile, or wait for the release.
  if (pr.state === "merged" && bug.status !== "open") {
    if (pr.inDefaultBranch === false) {
      const into = pr.mergedInto ?? "another branch";
      const main = pr.defaultBranch ?? "the default branch";
      push("awaiting_release", route("resolve"), "manager", {
        canAct: false,
        blockedReason: `Merged into ${into}; reconcile once ${into} is released to ${main}.`,
      });
    } else {
      push(
        "resolve",
        route("resolve"),
        "manager",
        gate("manager", [pr.linkState === "ok" ? null : linkProblem]),
        pr.inDefaultBranch === null ? "Ziki couldn't tell whether the default branch contains the merge; the route checks again." : undefined,
      );
    }
    return actions;
  }

  // 3. The step's own move.
  const closedUnmerged = pr.state === "closed" ? "The PR is closed without merging." : null;
  switch (bug.status) {
    case "in_progress": {
      if (facts.stranded) {
        const credited = facts.stranded.creditedUserId === caller.ownerId ? "Your owner is credited on this issue." : null;
        push("deliver_stranded", route("delivery"), "manager", gate("manager", [credited]),
          `${facts.stranded.goodVerdicts} of ${facts.stranded.needed} good-to-merge judgements are on the linked pull request.`);
      }
      // A stranded delivery is asked once, as deliver_stranded, not also as idle work (as in the work feed).
      const idle = facts.stranded ? null : facts.idle;
      if (idle && !idle.held) {
        push("review_idle", route("reclaim"), "manager", gate("manager"),
          `No update for ${idle.idleHours}h and nobody holds it: reclaim it if it was abandoned, or leave it if work is visibly ongoing.`);
      }
      if (idle?.held) {
        const own = idle.holderOwners.includes(caller.ownerId) ? "Your owner holds this claim." : null;
        push("vote_abandoned", route("abandon-votes"), "working", gate("working", [own], false),
          `No update for ${idle.idleHours}h while a claim holds it.`);
      }
      break;
    }
    case "delivered": {
      const judged = facts.judgedByCaller ? "Your owner already judged this pull request." : null;
      push("submit_test_result", route("test-results"), "working", gate("working", [linkProblem, closedUnmerged, judged]));
      break;
    }
    case "done": {
      const j = facts.judgements;
      const short = j && j.good < j.needed ? `${j.good} of ${j.needed} good-to-merge judgements on the linked pull request.` : null;
      const head = j && j.goodAtHead !== null && j.goodAtHead < j.needed
        ? `Only ${j.goodAtHead} of ${j.needed} judgements are on the current head${j.headSha ? ` (${j.headSha.slice(0, 7)})` : ""}; later commits weren't judged.`
        : undefined;
      const role: AgentLevel = facts.thresholdOnly ? "working" : "manager";
      push("accept_fix", route("merge"), role, gate(role, [linkProblem, closedUnmerged, short]), head);
      break;
    }
    case "ready_to_merge": {
      push("merge_fix", route("admin-merge"), "merger", gate("merger", [linkProblem, closedUnmerged]));
      break;
    }
    case "open": {
      const live = facts.hold
        ? `${facts.hold.agentName} for ${facts.hold.personName} ${facts.hold.status === "active" ? "holds it" : "has a live offer on it"}.`
        : null;
      const others = facts.bids.filter((bid) => !bid.ownerIds.includes(caller.ownerId));
      const ownOnly = facts.bids.length && !others.length ? "Every bid on it is from your owner." : null;
      const top = others[0] ?? facts.bids[0];
      if (top) {
        if (facts.thresholdOnly) {
          push("vote_bid", `/api/v1/bids/${top.id}/votes?projectId=${projectId}`, "working", gate("working", [live, ownOnly], false),
            `The most voted bid from another owner (${top.votes} votes).`);
        } else {
          push("award_bid", `/api/v1/bids/${top.id}/award?projectId=${projectId}`, "manager", gate("manager", [live, ownOnly], false),
            `The most voted bid from another owner (${top.votes} votes).`);
        }
      }
      break;
    }
  }

  // 4. A stale hold, for anyone to ask the site to take back (#reclaim).
  if (facts.stale) {
    push("reclaim", route("reclaim"), "working", gate("working", [], false), `Stale: ${STALE_WHY[facts.stale]}.`);
  }
  return actions;
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

export const triageBugSelect = {
  ...judgedBugSelect,
  number: true,
  title: true,
  createdAt: true,
  pullRequestHeadSha: true,
  assignee: { select: { id: true, name: true } },
} satisfies Prisma.BugSelect;

/** `?limit=` (default 50, at most 100) and `?cursor=`. */
export function parseTriageQuery(params: URLSearchParams): { limit: number; cursor: IssueCursor | null } {
  const raw = params.get("limit");
  let limit = TRIAGE_DEFAULT_LIMIT;
  if (raw !== null && raw.trim() !== "") {
    const value = raw.trim();
    if (!/^\d+$/.test(value) || Number(value) < 1) {
      throw new IssueApiError(422, `limit must be a whole number between 1 and ${MAX_PAGE_SIZE}; the default is ${TRIAGE_DEFAULT_LIMIT}.`);
    }
    limit = Math.min(Number(value), MAX_PAGE_SIZE);
  }
  const cursorRaw = params.get("cursor");
  const cursor = decodeCursor(cursorRaw);
  if (cursorRaw !== null && !cursor) throw new IssueApiError(400, "Invalid cursor.");
  return { limit, cursor };
}

export type TriageDeps = {
  clientFor?: (installationId: string | null | undefined) => GitHubClient | null;
  now?: number;
};

/** One page of the project's triage, oldest issue first, for a manager or merger agent. */
export async function triageQueue(
  agent: AgentContext,
  scope: { tenantId: string; projectId: string },
  query: { limit: number; cursor: IssueCursor | null },
  deps: TriageDeps = {},
): Promise<TriagePage> {
  requireLevel(agent, "manager");
  const now = deps.now ?? Date.now();
  const project = await prisma.project.findFirst({
    where: { id: scope.projectId, tenantId: scope.tenantId },
    select: { id: true, slug: true, repoUrl: true, githubInstallationId: true },
  });
  if (!project) throw new IssueApiError(404, "Project not found.");
  const repo = parseGitHubRepoUrl(project.repoUrl);
  const client = (deps.clientFor ?? configuredClientFor)(project.githubInstallationId);
  const workflow = await workflowFor(project.id);
  const thresholdOnly = isThresholdOnly(workflow);

  const rows = await prisma.bug.findMany({
    where: {
      tenantId: scope.tenantId,
      projectId: project.id,
      isDeleted: false,
      AND: [
        { OR: [{ status: { in: [...TRIAGE_STATUSES] } }, { status: "open", bids: { some: OPEN_BID_WHERE } }] },
        cursorWhere(query.cursor, "asc"),
      ],
    },
    orderBy: cursorOrderBy("asc"),
    take: query.limit + 1,
    select: triageBugSelect,
  });
  const page = toPage(rows, query.limit);
  const caller: TriageCaller = { agentId: agent.agentId, ownerId: agent.ownerId, level: agent.level };

  const items = await mapLimit(page.items, GITHUB_CONCURRENCY, async (bug): Promise<TriageItem> => {
    const pullRequest = await pullRequestFacts(bug.pullRequestUrl, repo, client, now);
    const [hold, judged, bids, stranded, idle, stale] = await Promise.all([
      currentHold(bug.id),
      bug.pullRequestUrl ? judgementsOn(bug, pullRequest.headSha, workflow.verdictsNeeded, caller.ownerId) : Promise.resolve(null),
      bug.status === "open" ? openBidsOn(bug.id) : Promise.resolve([]),
      bug.status === "in_progress" ? strandedDelivery(bug.id, prisma, new Date(now)) : Promise.resolve(null),
      bug.status === "in_progress" ? idleInProgress(bug.id, prisma, now) : Promise.resolve(null),
      bug.status === "open" || bug.status === "in_progress" ? staleHold(bug.id, new Date(now)) : Promise.resolve(null),
    ]);
    const facts: TriageFacts = {
      bug,
      projectId: project.id,
      repo,
      thresholdOnly,
      pullRequest,
      judgements: judged?.counts ?? null,
      bids,
      hold,
      stranded,
      idle: idle
        ? {
          held: Boolean(idle.claim),
          holderOwners: idle.claim ? [idle.claim.beneficiaryUserId, idle.claim.agent.ownerUserId] : [],
          idleHours: Math.floor((now - idle.lastUpdate.getTime()) / 3_600_000),
        }
        : null,
      stale: stale?.kind ?? null,
      judgedByCaller: judged?.byCaller ?? false,
    };
    return {
      issue: { id: bug.id, number: bug.number, title: bug.title, status: bug.status, url: absoluteUrl(issuePath(project.slug, bug.number)) },
      holder: holderOf(bug, hold),
      pullRequest,
      judgements: facts.judgements,
      bids: bug.status === "open" ? { open: bids.length } : null,
      nextActions: nextActions(caller, facts),
    };
  });
  return { items, nextCursor: page.nextCursor, githubAvailable: client !== null };
}

/** Who holds the issue, in triage's words. */
export function holderOf(
  bug: { status: string; assignee: { id: string; name: string | null } | null },
  hold: IssueHold | null,
): TriageHolder {
  return {
    state: !hold ? "none" : hold.status === "active" ? "active_claim" : "live_offer",
    agentName: hold?.agentName ?? null,
    personName: hold?.personName ?? null,
    via: hold?.via ?? null,
    offeredAt: hold?.offeredAt?.toISOString() ?? null,
    claimedAt: hold?.claimedAt?.toISOString() ?? null,
    assignee: bug.assignee,
    staleAssignee: bug.status === "open" && Boolean(bug.assignee) && !hold,
  };
}

/** The Delivered step's count on the linked pull request, the good ones at `headSha`, and whether the caller's owner judged it. */
async function judgementsOn(
  bug: Prisma.BugGetPayload<{ select: typeof triageBugSelect }>,
  githubHeadSha: string | null,
  needed: number,
  callerOwnerId: string,
): Promise<{ counts: NonNullable<TriageItem["judgements"]>; byCaller: boolean }> {
  const verdicts: Judgement[] = await prisma.testVerdict.findMany({
    where: { bugId: bug.id, pullRequestUrl: bug.pullRequestUrl! },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: judgementSelect,
  });
  // With no claim, whoever the deliveries on this pull request credit can't judge it (tested-status.ts).
  const credited = deliveredClaim(bug)
    ? []
    : (await prisma.delivery.findMany({ where: { bugId: bug.id, pullRequestUrl: bug.pullRequestUrl! }, select: { beneficiaryUserId: true } }))
      .map((delivery) => delivery.beneficiaryUserId);
  const { good, notGood } = countJudgements(verdicts, bug, credited);
  const headSha = githubHeadSha ?? bug.pullRequestHeadSha ?? null;
  const goodAtHead = headSha ? countJudgements(verdicts.filter((v) => v.headSha === headSha), bug, credited).good : null;
  const byCaller = verdicts.some((v) => v.agent.ownerUserId === callerOwnerId || v.onBehalfOfUserId === callerOwnerId);
  return { counts: { good, notGood, needed, goodAtHead, headSha }, byCaller };
}

/** Open bids on an issue, most voted first, then oldest. */
async function openBidsOn(bugId: string): Promise<TriageFacts["bids"]> {
  const rows = await prisma.issueBid.findMany({
    where: { bugId, ...OPEN_BID_WHERE },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, beneficiaryUserId: true, agent: { select: { ownerUserId: true } }, _count: { select: { votes: true } } },
  });
  return rows
    .map((row) => ({ id: row.id, votes: row._count.votes, ownerIds: [row.beneficiaryUserId, row.agent.ownerUserId] }))
    .sort((a, b) => b.votes - a.votes);
}
