import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

type Row = {
  id: string;
  bugId: string;
  agentId: string;
  onBehalfOfUserId: string;
  goodToMerge: boolean;
  summary: string;
  description: string;
  pullRequestUrl?: string | null;
  changedAt?: Date | null;
};

const state = vi.hoisted(() => ({ verdicts: [] as Row[] }));

const db = vi.hoisted(() => ({
  bug: { findFirst: vi.fn() },
  membership: { findUnique: vi.fn() },
  testVerdict: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  pullRequestReport: { findFirst: vi.fn() },
  agentAuditEvent: { create: vi.fn() },
  comment: { create: vi.fn() },
  bugActivity: { create: vi.fn() },
  agentEvent: { create: vi.fn() },
  webhookSubscription: { findMany: vi.fn() },
  webhookDelivery: { createMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

const tested = vi.hoisted(() => ({ refreshJudgedStatus: vi.fn() }));
vi.mock("@/lib/agent-api/tested-status", () => ({ refreshJudgedStatus: tested.refreshJudgedStatus }));

const notify = vi.hoisted(() => ({ notifyMergeFailed: vi.fn() }));
vi.mock("@/lib/agent-notifications", () => ({ notifyMergeFailed: notify.notifyMergeFailed }));

const PR = "https://github.com/Zedu-Endor/issue-tracker/pull/42";

/** The latest independent report on the pull request (#pr-reports); by default open, checks passing, no conflict. */
function report(overrides: Record<string, unknown> = {}) {
  return {
    id: "rep1",
    bugId: "bug1",
    pullRequestUrl: PR,
    state: "open",
    mergedInto: null,
    inDefaultBranch: null,
    headSha: null,
    mergeCommitSha: null,
    checks: "passing",
    mergeable: true,
    note: "Checked it on GitHub.",
    agentId: "checker",
    onBehalfOfUserId: "cy",
    createdAt: new Date("2026-10-30T09:00:00Z"),
    agent: { name: "checker" },
    onBehalfOf: { name: "Cy" },
    ...overrides,
  };
}

import { submitTestVerdict } from "./test-verdict";

/** An issue Ada filed herself, with no agent and no claim. */
function bugRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bug1",
    tenantId: "tenant_zedu",
    status: "delivered",
    pullRequestUrl: PR,
    pullRequestHeadSha: null as string | null,
    title: "A fix",
    assigneeId: "ada",
    project: { repoUrl: "https://github.com/Zedu-Endor/issue-tracker" },
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

const good = { goodToMerge: true, summary: "Good to merge.", description: "Tested on the branch: it works." };
const notGood = (description: string) => ({ goodToMerge: false, summary: "Not good to merge.", description });

beforeEach(() => {
  vi.clearAllMocks();
  state.verdicts = [];
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  db.bug.findFirst.mockResolvedValue(bugRow());
  db.membership.findUnique.mockResolvedValue({ id: "m1" });
  db.comment.create.mockResolvedValue({ id: "c1" });
  db.bugActivity.create.mockResolvedValue({});
  db.pullRequestReport.findFirst.mockResolvedValue(report());
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
    const changed = await submitTestVerdict(rob, "bug1", notGood("Regresses the Safari login"));
    expect(changed).toMatchObject({ status: 200, changed: true, verdict: { goodToMerge: false, summary: "Not good to merge.", description: "Regresses the Safari login" } });
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

    await submitTestVerdict(rob, "bug1", notGood("Regressed."));

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

  it("can't change once a manager accepted the work, or before it is delivered", async () => {
    for (const status of ["ready_to_merge", "resolved", "in_progress", "open"]) {
      db.bug.findFirst.mockResolvedValue(bugRow({ status }));
      expect(await submitTestVerdict(reviewer("r1", "rob"), "bug1", notGood("Regressed."))).toMatchObject({
        status: 409,
        error: "not_delivered",
      });
    }
    expect(db.testVerdict.update).not.toHaveBeenCalled();
  });
});

describe("submitTestVerdict: judges delivered work (#526, #delivered-step)", () => {
  it("is refused until the work is delivered", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ pullRequestUrl: null }));
    expect(await submitTestVerdict(reviewer("r1", "rob"), "bug1", good)).toMatchObject({
      status: 409,
      error: "not_delivered",
    });
    expect(db.testVerdict.create).not.toHaveBeenCalled();
  });

  it("refuses a new good-to-merge once the work is Done, and reads no pull request report (#727)", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ status: "done" }));
    expect(await submitTestVerdict(reviewer("r3", "rose"), "bug1", good)).toMatchObject({ status: 409, error: "enough_verdicts" });
    expect(db.testVerdict.create).not.toHaveBeenCalled();
    expect(db.pullRequestReport.findFirst).not.toHaveBeenCalled();
    expect(tested.refreshJudgedStatus).not.toHaveBeenCalled();
  });

  it("still records a not-good-to-merge on Done work, and a reviewer's change of their own (#727)", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ status: "done" }));
    expect(await submitTestVerdict(reviewer("r3", "rose"), "bug1", notGood("Regressed on mobile."))).toMatchObject({ status: 201 });
    state.verdicts.push({ id: "tv9", bugId: "bug1", agentId: "r1", onBehalfOfUserId: "rob", goodToMerge: true, summary: "Good.", description: "Tested." });
    expect(await submitTestVerdict(reviewer("r1", "rob"), "bug1", good)).toMatchObject({ status: 200, changed: true });
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
    await submitTestVerdict(reviewer("r1", "rob"), "bug1", { ...good, headSha: "abc1234" });
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
    const result = await submitTestVerdict(reviewer("r1", "rob"), "bug1", { ...good, headSha: "not-a-sha" });
    expect(result).toMatchObject({ status: 400, field: "headSha" });
    expect(db.testVerdict.create).not.toHaveBeenCalled();
  });
});

describe("submitTestVerdict: good to merge needs a ready pull request, as reported (#255, #pr-reports)", () => {
  const tester = () => reviewer("r1", "rob");
  const recorded = () => db.testVerdict.create.mock.calls.length + db.testVerdict.update.mock.calls.length;
  /** What the caller is told: the reason, then what the author has to do. Nothing is posted (#review-entries). */
  const refusal = (result: unknown) => {
    expect(db.comment.create).not.toHaveBeenCalled();
    expect(db.bugActivity.create).not.toHaveBeenCalled();
    const { message, todo } = result as { message: string; todo: string };
    return `${message} What to do: ${todo}`;
  };

  it("records the verdict when the latest report says checks pass and there is no conflict", async () => {
    expect(await submitTestVerdict(tester(), "bug1", good)).toMatchObject({ status: 201 });
    expect(db.pullRequestReport.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { bugId: "bug1", pullRequestUrl: PR } }));
    expect(db.comment.create).not.toHaveBeenCalled();
  });

  it("records the verdict when nobody has reported the pull request yet: the tester's own check stands", async () => {
    db.pullRequestReport.findFirst.mockResolvedValue(null);
    expect(await submitTestVerdict(tester(), "bug1", good)).toMatchObject({ status: 201 });
  });

  it("records the verdict while the reported checks are still running", async () => {
    db.pullRequestReport.findFirst.mockResolvedValue(report({ checks: "pending" }));
    expect(await submitTestVerdict(tester(), "bug1", good)).toMatchObject({ status: 201 });
  });

  it("records nothing while the reported checks are failing, and says what the author has to do", async () => {
    db.pullRequestReport.findFirst.mockResolvedValue(report({ checks: "failing" }));

    const result = await submitTestVerdict(tester(), "bug1", good);

    expect(result).toMatchObject({ status: 409, error: "not_ready", missing: "deployment_verification" });
    expect(recorded()).toBe(0);
    expect(refusal(result)).toMatch(/^The latest report says its checks are failing.*What to do: The author opens the pull request's Checks tab/);
    expect(notify.notifyMergeFailed).toHaveBeenCalledWith(expect.objectContaining({ recipientId: "ada" }));
  });

  it("records nothing while the report says the pull request conflicts with its base branch", async () => {
    db.pullRequestReport.findFirst.mockResolvedValue(report({ mergeable: false }));

    const result = await submitTestVerdict(tester(), "bug1", good);
    expect(result).toMatchObject({ status: 409, missing: "merge_conflict" });
    expect(recorded()).toBe(0);
    expect(refusal(result)).toMatch(/don't resolve conflicts.*come and resolve it/);
  });

  it("records nothing when the report says the pull request is closed or missing", async () => {
    for (const state of ["closed", "not_found"]) {
      db.pullRequestReport.findFirst.mockResolvedValueOnce(report({ state, checks: null, mergeable: null }));
      expect(await submitTestVerdict(tester(), "bug1", good)).toMatchObject({ status: 409, error: "not_ready", missing: "pull_request" });
    }
    expect(recorded()).toBe(0);
  });

  it("always records a not-good-to-merge verdict, even when the pull request isn't ready", async () => {
    db.pullRequestReport.findFirst.mockResolvedValue(report({ checks: "failing" }));

    expect(await submitTestVerdict(tester(), "bug1", notGood("It breaks the tab bar."))).toMatchObject({ status: 201 });
    expect(db.comment.create).not.toHaveBeenCalled();
  });
});

describe("submitTestVerdict: applies the Delivered rule after each judgement (#delivered-step)", () => {
  it("re-counts the judgements after every recorded one", async () => {
    expect(await submitTestVerdict(reviewer("r1", "rob"), "bug1", good)).toMatchObject({ status: 201 });
    expect(tested.refreshJudgedStatus).toHaveBeenCalledWith(db, "bug1", "rob");
  });

  it("re-counts when a reviewer changes a judgement", async () => {
    await submitTestVerdict(reviewer("r1", "rob"), "bug1", good);
    tested.refreshJudgedStatus.mockClear();
    await submitTestVerdict(reviewer("r1", "rob"), "bug1", notGood("Breaks the tab bar."));
    expect(tested.refreshJudgedStatus).toHaveBeenCalledWith(db, "bug1", "rob");
  });
});

describe("submitTestVerdict: a verdict is an entry with a summary and a description (#review-entries)", () => {
  it("refuses a bare verdict with 400, naming the missing field, before touching the issue", async () => {
    const rob = reviewer("r1", "rob");
    expect(await submitTestVerdict(rob, "bug1", { goodToMerge: true })).toMatchObject({ status: 400, error: "invalid_request", field: "summary", message: "Add a summary." });
    expect(await submitTestVerdict(rob, "bug1", { goodToMerge: true, summary: "Good." })).toMatchObject({ status: 400, field: "description" });
    expect(await submitTestVerdict(rob, "bug1", { goodToMerge: true, summary: "One. Two. Three.", description: "x" })).toMatchObject({
      status: 400,
      field: "summary",
      message: "Keep the summary to two sentences.",
    });
    expect(db.bug.findFirst).not.toHaveBeenCalled();
    expect(state.verdicts).toHaveLength(0);
  });

  it("refuses a verdict with no summary or description", async () => {
    const result = await submitTestVerdict(reviewer("r1", "rob"), "bug1", { goodToMerge: true, notes: "Looks good." });
    expect(result).toMatchObject({ status: 400, error: "invalid_request" });
  });

  it("stores the summary and description, and returns them", async () => {
    const result = await submitTestVerdict(reviewer("r1", "rob"), "bug1", good);
    expect(result).toMatchObject({ status: 201, verdict: { summary: "Good to merge.", description: "Tested on the branch: it works." } });
    expect(db.testVerdict.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ summary: "Good to merge.", description: "Tested on the branch: it works." }) }),
    );
  });

  it("a blocked good to merge returns the refusal with what to do, and posts no comment", async () => {
    db.pullRequestReport.findFirst.mockResolvedValue(report({ checks: "failing" }));
    const result = await submitTestVerdict(reviewer("r1", "rob"), "bug1", good);
    expect(result).toMatchObject({ status: 409, error: "not_ready", missing: "deployment_verification", todo: expect.stringContaining("Checks tab") });
    expect(db.comment.create).not.toHaveBeenCalled();
    expect(db.bugActivity.create).not.toHaveBeenCalled();
  });
});
