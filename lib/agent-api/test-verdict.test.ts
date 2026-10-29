import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

type Row = {
  id: string;
  bugId: string;
  agentId: string;
  onBehalfOfUserId: string;
  goodToMerge: boolean;
  notes: string | null;
  pullRequestUrl?: string | null;
  changedAt?: Date | null;
};

const state = vi.hoisted(() => ({ verdicts: [] as Row[] }));

const db = vi.hoisted(() => ({
  bug: { findFirst: vi.fn() },
  membership: { findUnique: vi.fn() },
  testVerdict: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  agentAuditEvent: { create: vi.fn() },
  comment: { create: vi.fn() },
  bugActivity: { create: vi.fn() },
  agentEvent: { create: vi.fn() },
  webhookSubscription: { findMany: vi.fn() },
  webhookDelivery: { createMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

const tested = vi.hoisted(() => ({ refreshTestedStatus: vi.fn() }));
vi.mock("@/lib/agent-api/tested-status", () => ({ refreshTestedStatus: tested.refreshTestedStatus }));

const gh = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("@/lib/agent-api/pr-readiness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-api/pr-readiness")>()),
  readinessClient: gh.client,
}));
const notify = vi.hoisted(() => ({ notifyMergeFailed: vi.fn() }));
vi.mock("@/lib/agent-notifications", () => ({ notifyMergeFailed: notify.notifyMergeFailed }));

import type { GitHubClient } from "@/lib/github/merge-pr";

/** A pull request that is ready: no conflict, checks green, no open CodeRabbit threads. */
function readyClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    getPullRequest: vi.fn(async () => ({ state: "open", merged: false, mergeable: true, headSha: "abc1234" })),
    checksGreen: vi.fn(async () => true),
    unresolvedCodeRabbitThreads: vi.fn(async () => 0),
    mergePullRequest: vi.fn(async () => ({ merged: true })),
    ...overrides,
  };
}

import { submitTestVerdict } from "./test-verdict";

/** An issue Ada filed herself, with no agent and no claim. */
function bugRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bug1",
    tenantId: "tenant_zedu",
    status: "in_progress",
    pullRequestUrl: "https://github.com/Zedu-Endor/issue-tracker/pull/42",
    pullRequestHeadSha: null as string | null,
    title: "A fix",
    assigneeId: "ada",
    project: { githubInstallationId: "app-1" },
    severity: "medium",
    beneficiaryUserId: "ada",
    createdByAgentId: null,
    createdByAgent: null,
    claims: [],
    ...overrides,
  };
}

function reviewer(id: string, ownerId: string, level: "working" | "manager" | "merger" = "working") {
  return { agentId: id, name: id, ownerId, tenantId: "tenant_zedu", level, burst: false, keyId: `key-${id}` };
}

const good = { goodToMerge: true };

beforeEach(() => {
  vi.clearAllMocks();
  state.verdicts = [];
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  db.bug.findFirst.mockResolvedValue(bugRow());
  db.membership.findUnique.mockResolvedValue({ id: "m1" });
  db.comment.create.mockResolvedValue({ id: "c1" });
  db.bugActivity.create.mockResolvedValue({});
  gh.client.mockReturnValue(readyClient());
  db.agentEvent.create.mockResolvedValue({ id: "e1" });
  db.webhookSubscription.findMany.mockResolvedValue([]);
  db.testVerdict.findFirst.mockImplementation(async ({ where }: { where: Record<string, string> }) => {
    // A copy, as Prisma returns: a later update mustn't change what was read.
    const row = state.verdicts.find((v) => v.bugId === where.bugId && v.agentId === where.agentId);
    return row ? { ...row } : null;
  });
  db.testVerdict.create.mockImplementation(async ({ data }: { data: Omit<Row, "id"> }) => {
    const row = { id: `tv${state.verdicts.length + 1}`, changedAt: null, ...data };
    state.verdicts.push(row);
    return row;
  });
  db.testVerdict.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
    const row = state.verdicts.find((v) => v.id === where.id)!;
    Object.assign(row, data);
    return row;
  });
});

describe("submitTestVerdict: who may verdict (#434)", () => {
  it("blocks the assigned solver's other reviewer agent even when credit is delegated", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ assigneeId: "rob" }));
    expect(await submitTestVerdict(reviewer("second-agent", "rob"), "bug1", { ...good, onBehalfOfUserId: "someone-else" })).toMatchObject({ status: 403, error: "not_independent" });
    expect(state.verdicts).toHaveLength(0);
  });
  it("rejects an agent with no valid class before touching the issue", async () => {
    const result = await submitTestVerdict(reviewer("c1", "cara", "observer" as never), "bug1", good);
    expect(result).toMatchObject({ status: 403, error: "insufficient_level", message: "This agent can't report a test verdict." });
    expect(db.bug.findFirst).not.toHaveBeenCalled();
  });

  it("is 404 for an issue outside the agent's tenant or deleted", async () => {
    db.bug.findFirst.mockResolvedValue(null);
    expect(await submitTestVerdict(reviewer("r1", "rob"), "bug1", good)).toMatchObject({ status: 404 });
    expect(db.bug.findFirst.mock.calls[0][0].where).toEqual({ id: "bug1", tenantId: "tenant_zedu", isDeleted: false });
  });

  it("rejects the agent holding the active claim", async () => {
    db.bug.findFirst.mockResolvedValue(
      bugRow({ claims: [{ status: "active", releasedAt: null, agentId: "r1", agent: { ownerUserId: "rob" } }] }),
    );
    expect(await submitTestVerdict(reviewer("r1", "rob"), "bug1", good)).toMatchObject({
      status: 403,
      error: "fixer_cannot_verdict",
    });
    expect(state.verdicts).toHaveLength(0);
  });

  it("rejects a reviewer whose owner is the beneficiary, or whose owner is the filing agent's", async () => {
    expect(await submitTestVerdict(reviewer("r3", "ada"), "bug1", good)).toMatchObject({
      status: 403,
      error: "not_independent",
    });
    db.bug.findFirst.mockResolvedValue(bugRow({ createdByAgentId: "f1", createdByAgent: { ownerUserId: "rob" } }));
    expect(await submitTestVerdict(reviewer("r2", "rob"), "bug1", good)).toMatchObject({
      status: 403,
      error: "not_independent",
    });
    expect(state.verdicts).toHaveLength(0);
  });

  it("rejects the human reporter's own agent when the beneficiary is unset (#620)", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ beneficiaryUserId: null, reporterId: "ada" }));
    expect(await submitTestVerdict(reviewer("r4", "ada"), "bug1", good)).toMatchObject({
      status: 403,
      error: "not_independent",
    });
    expect(db.bug.findFirst.mock.calls[0][0].select.reporterId).toBe(true);
  });

  it("rejects a reviewer whose owner holds the active claim", async () => {
    db.bug.findFirst.mockResolvedValue(
      bugRow({ claims: [{ status: "active", releasedAt: null, agentId: "w1", agent: { ownerUserId: "rob" } }] }),
    );
    expect(await submitTestVerdict(reviewer("r2", "rob"), "bug1", good)).toMatchObject({
      status: 403,
      error: "not_independent",
    });
  });

  it("rejects verdicts credited to the reporter, assigned solver, or claim beneficiary (#495)", async () => {
    for (const bug of [
      bugRow({ reporterId: "reporter", beneficiaryUserId: "beneficiary" }),
      bugRow({ reporterId: "reporter", beneficiaryUserId: "beneficiary", assigneeId: "solver" }),
      bugRow({ reporterId: "reporter", beneficiaryUserId: "beneficiary", claims: [
        { status: "active", releasedAt: null, agentId: "worker-agent", beneficiaryUserId: "claimant", agent: { ownerUserId: "worker" } },
      ] }),
    ]) {
      db.bug.findFirst.mockResolvedValueOnce(bug);
    }
    for (const creditedUser of ["reporter", "solver", "claimant"]) {
      expect(await submitTestVerdict(reviewer("r1", "rob"), "bug1", { ...good, onBehalfOfUserId: creditedUser })).toMatchObject({
        status: 403,
        error: "not_independent",
      });
    }
    expect(state.verdicts).toHaveLength(0);
  });
});

describe("submitTestVerdict: the body and record (#434)", () => {
  it("records a good-to-merge verdict for the owner", async () => {
    const result = await submitTestVerdict(reviewer("r1", "rob"), "bug1", good);
    expect(result).toMatchObject({ status: 201, verdict: { goodToMerge: true, onBehalfOfUserId: "rob" } });
    expect(state.verdicts[0]).toMatchObject({ bugId: "bug1", agentId: "r1", onBehalfOfUserId: "rob", goodToMerge: true });
  });

  it("requires a boolean goodToMerge", async () => {
    expect(await submitTestVerdict(reviewer("r1", "rob"), "bug1", {})).toMatchObject({
      status: 400,
      field: "goodToMerge",
    });
    expect(await submitTestVerdict(reviewer("r1", "rob"), "bug1", { goodToMerge: "yes" })).toMatchObject({ status: 400 });
  });

  it("acts for the owner unless it names another member of the tenant", async () => {
    db.membership.findUnique.mockResolvedValue(null);
    expect(
      await submitTestVerdict(reviewer("r1", "rob"), "bug1", { ...good, onBehalfOfUserId: "stranger" }),
    ).toMatchObject({ status: 400, field: "onBehalfOfUserId" });
    expect(state.verdicts).toHaveLength(0);
  });

  it("keeps one verdict per agent per issue: reporting again replaces it (#529)", async () => {
    const rob = reviewer("r1", "rob");
    expect(await submitTestVerdict(rob, "bug1", good)).toMatchObject({ status: 201 });
    const changed = await submitTestVerdict(rob, "bug1", { goodToMerge: false, notes: "Regresses the Safari login" });
    expect(changed).toMatchObject({ status: 200, changed: true, verdict: { goodToMerge: false, notes: "Regresses the Safari login" } });
    expect(state.verdicts).toHaveLength(1);
    expect(state.verdicts[0]).toMatchObject({ goodToMerge: false, changedAt: expect.any(Date) });
  });

  it("handles concurrent inserts deterministically when unique constraint is hit (#712)", async () => {
    const rob = reviewer("r1", "rob");
    db.testVerdict.findFirst.mockResolvedValueOnce(null);
    db.testVerdict.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "6.0.0",
      }),
    );
    const result = await submitTestVerdict(rob, "bug1", good);
    expect(result).toMatchObject({
      status: 409,
      error: "already_verdicted",
      message: "This agent has already reported a verdict on this issue.",
    });
  });

  it("audits and publishes every verdict", async () => {
    await submitTestVerdict(reviewer("r1", "rob"), "bug1", good);
    expect(db.agentAuditEvent.create.mock.calls[0][0].data).toMatchObject({
      agentId: "r1",
      action: "issue.test_verdict",
      target: "bug:bug1",
      bugId: "bug1",
    });
    expect(db.agentEvent.create.mock.calls[0][0].data).toMatchObject({
      tenantId: "tenant_zedu",
      type: "issue.test_verdict",
      bugId: "bug1",
    });
  });
});

describe("submitTestVerdict: changing a verdict (#529)", () => {
  it("audits the change with the old and new verdict, and publishes it", async () => {
    const rob = reviewer("r1", "rob");
    await submitTestVerdict(rob, "bug1", good);
    vi.clearAllMocks();
    db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
    db.bug.findFirst.mockResolvedValue(bugRow());
    db.agentEvent.create.mockResolvedValue({ id: "e2" });
    db.webhookSubscription.findMany.mockResolvedValue([]);

    await submitTestVerdict(rob, "bug1", { goodToMerge: false });

    expect(db.testVerdict.create).not.toHaveBeenCalled();
    expect(db.agentAuditEvent.create.mock.calls[0][0].data).toMatchObject({
      action: "issue.test_verdict_changed",
      payload: expect.objectContaining({ from: expect.objectContaining({ goodToMerge: true }), to: expect.objectContaining({ goodToMerge: false }) }),
    });
    expect(db.agentEvent.create.mock.calls[0][0].data).toMatchObject({
      type: "issue.test_verdict",
      payload: expect.objectContaining({ goodToMerge: false, changed: true, previousGoodToMerge: true }),
    });
  });

  it("can't change once the fix is accepted", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ status: "resolved" }));
    expect(await submitTestVerdict(reviewer("r1", "rob"), "bug1", { goodToMerge: false })).toMatchObject({
      status: 409,
      error: "already_accepted",
    });
    expect(db.testVerdict.update).not.toHaveBeenCalled();
  });
});

describe("submitTestVerdict: needs a pull request (#526)", () => {
  it("is refused until a pull request is linked", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ pullRequestUrl: null }));
    expect(await submitTestVerdict(reviewer("r1", "rob"), "bug1", good)).toMatchObject({
      status: 409,
      error: "no_pull_request",
    });
    expect(db.testVerdict.create).not.toHaveBeenCalled();
  });

  it("records the pull request it tested", async () => {
    await submitTestVerdict(reviewer("r1", "rob"), "bug1", good);
    expect(db.testVerdict.create.mock.calls[0][0].data).toMatchObject({
      pullRequestUrl: "https://github.com/Zedu-Endor/issue-tracker/pull/42",
    });
  });
});

describe("submitTestVerdict: the head commit it tested (#489)", () => {
  it("records the head commit named in the body", async () => {
    await submitTestVerdict(reviewer("r1", "rob"), "bug1", { goodToMerge: true, headSha: "abc1234" });
    expect(db.testVerdict.create.mock.calls[0][0].data).toMatchObject({
      pullRequestUrl: "https://github.com/Zedu-Endor/issue-tracker/pull/42",
      headSha: "abc1234",
    });
  });

  it("defaults to the head SHA recorded when the pull request was linked", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ pullRequestHeadSha: "linked-sha" }));
    await submitTestVerdict(reviewer("r1", "rob"), "bug1", good);
    expect(db.testVerdict.create.mock.calls[0][0].data).toMatchObject({ headSha: "linked-sha" });
  });

  it("stores no head commit when neither the body nor the link names one", async () => {
    await submitTestVerdict(reviewer("r1", "rob"), "bug1", good);
    expect(db.testVerdict.create.mock.calls[0][0].data).toMatchObject({ headSha: null });
  });

  it("rejects a head commit that is not a hexadecimal SHA", async () => {
    const result = await submitTestVerdict(reviewer("r1", "rob"), "bug1", {
      goodToMerge: true,
      headSha: "not-a-sha",
    });
    expect(result).toMatchObject({ status: 400, field: "headSha" });
    expect(db.testVerdict.create).not.toHaveBeenCalled();
  });
});

describe("submitTestVerdict: good to merge needs a ready pull request (#255)", () => {
  const tester = () => reviewer("r1", "rob");
  const recorded = () => db.testVerdict.create.mock.calls.length + db.testVerdict.update.mock.calls.length;
  const commentBodies = () => db.comment.create.mock.calls.map((call) => call[0].data.body as string);

  it("records the verdict when checks are green, CodeRabbit is resolved and there is no conflict", async () => {
    expect(await submitTestVerdict(tester(), "bug1", good)).toMatchObject({ status: 201 });
    expect(db.comment.create).not.toHaveBeenCalled();
  });

  it("records nothing while the checks are red, and says what the author has to do", async () => {
    gh.client.mockReturnValue(readyClient({ checksGreen: vi.fn(async () => false) }));

    const result = await submitTestVerdict(tester(), "bug1", good);

    expect(result).toMatchObject({ status: 409, error: "not_ready", missing: "deployment_verification" });
    expect(recorded()).toBe(0);
    expect(commentBodies()[0]).toMatch(/^Good-to-merge verdict not recorded: GitHub Actions CI\/CD checks.*What to do: The author opens the pull request's Checks tab/);
    expect(notify.notifyMergeFailed).toHaveBeenCalledWith(expect.objectContaining({ recipientId: "ada" }));
  });

  it("records nothing while CodeRabbit has unresolved threads", async () => {
    gh.client.mockReturnValue(readyClient({ unresolvedCodeRabbitThreads: vi.fn(async () => 2) }));

    expect(await submitTestVerdict(tester(), "bug1", good)).toMatchObject({ status: 409, missing: "review_threads" });
    expect(recorded()).toBe(0);
    expect(commentBodies()[0]).toContain("2 unresolved review threads");
  });

  it("records nothing while the pull request conflicts with its base branch", async () => {
    gh.client.mockReturnValue(
      readyClient({ getPullRequest: vi.fn(async () => ({ state: "open", merged: false, mergeable: false, headSha: "abc1234" })) }),
    );

    expect(await submitTestVerdict(tester(), "bug1", good)).toMatchObject({ status: 409, missing: "merge_conflict" });
    expect(recorded()).toBe(0);
    expect(commentBodies()[0]).toMatch(/don't resolve conflicts.*come and resolve it/);
  });

  it("lists every reason in one comment when more than one thing is wrong", async () => {
    gh.client.mockReturnValue(
      readyClient({
        getPullRequest: vi.fn(async () => ({ state: "open", merged: false, mergeable: false, headSha: "abc1234" })),
        checksGreen: vi.fn(async () => false),
        unresolvedCodeRabbitThreads: vi.fn(async () => 1),
      }),
    );

    await submitTestVerdict(tester(), "bug1", good);

    expect(recorded()).toBe(0);
    expect(commentBodies()).toHaveLength(1);
    expect(commentBodies()[0]).toMatch(/for 3 reasons: \(1\) .*merge conflicts.*\(2\) GitHub Actions.*\(3\) CodeRabbit has 1 unresolved review thread/);
    expect(commentBodies()[0]).toMatch(/What to do: \(1\) .*\(2\) .*\(3\) /);
  });

  it("records nothing when GitHub can't be asked", async () => {
    gh.client.mockReturnValue(null);
    expect(await submitTestVerdict(tester(), "bug1", good)).toMatchObject({ status: 409, missing: "github_app" });
    expect(recorded()).toBe(0);

    gh.client.mockReturnValue(readyClient({ getPullRequest: vi.fn(async () => { throw new Error("boom"); }) }));
    expect(await submitTestVerdict(tester(), "bug1", good)).toMatchObject({ status: 409, missing: "deployment_verification" });
    expect(recorded()).toBe(0);
  });

  it("always records a not-good-to-merge verdict, even when the pull request isn't ready", async () => {
    gh.client.mockReturnValue(readyClient({ checksGreen: vi.fn(async () => false) }));

    expect(await submitTestVerdict(tester(), "bug1", { goodToMerge: false, notes: "It breaks the tab bar." })).toMatchObject({ status: 201 });
    expect(db.comment.create).not.toHaveBeenCalled();
  });
});

describe("submitTestVerdict: moves the fix to Done once enough reviewers agree (Ziki #713)", () => {
  it("re-counts the verdicts after every recorded verdict", async () => {
    expect(await submitTestVerdict(reviewer("r1", "rob"), "bug1", good)).toMatchObject({ status: 201 });
    expect(tested.refreshTestedStatus).toHaveBeenCalledWith(db, "bug1", "rob");
  });

  it("re-counts when a reviewer takes a verdict back", async () => {
    await submitTestVerdict(reviewer("r1", "rob"), "bug1", good);
    tested.refreshTestedStatus.mockClear();
    await submitTestVerdict(reviewer("r1", "rob"), "bug1", { goodToMerge: false, notes: "Breaks the tab bar." });
    expect(tested.refreshTestedStatus).toHaveBeenCalledWith(db, "bug1", "rob");
  });
});
