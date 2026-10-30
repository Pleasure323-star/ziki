import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIdeaFindMany = vi.hoisted(() => vi.fn());
const mockIdeaFindUnique = vi.hoisted(() => vi.fn());
const mockIdeaUpdate = vi.hoisted(() => vi.fn());
const mockAgentFindFirst = vi.hoisted(() => vi.fn());
const mockTransaction = vi.hoisted(() => vi.fn());
const mockAudit = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }));
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    idea: {
      findMany: mockIdeaFindMany,
      findUnique: mockIdeaFindUnique,
      update: mockIdeaUpdate,
    },
    agent: { findFirst: mockAgentFindFirst },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/agents/audit", () => ({ audit: mockAudit }));
vi.mock("@/lib/logger", () => ({ logger: mockLogger }));

import { sweepUndraftedIdeas } from "./draft-structuring";

const AGENT = { id: "agent_1", tenantId: "tenant_1" };

function makeIdea(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "idea_1",
    number: 42,
    title: "Raw idea",
    description:
      "Here's an idea: the export button doesn't work on mobile Safari, people keep asking about it, we should fix it or at least show an error.",
    status: "open",
    createdByAgentId: null,
    tenantId: "tenant_1",
    ...overrides,
  };
}

describe("sweepUndraftedIdeas (#682, #685)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentFindFirst.mockResolvedValue(AGENT);
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
      fn({ idea: { update: mockIdeaUpdate } }),
    );
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            text: JSON.stringify({
              summary: "Export button broken on mobile Safari",
              problem: "Clicking export does nothing on mobile Safari; no error shown.",
              proposedSolution: "Fix the handler or surface an error toast.",
              acceptanceCriteria: ["Export works on mobile Safari", "Failure shows an error"],
            }),
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);
  });

  it("returns immediately with nothing done when ANTHROPIC_API_KEY is missing", async () => {
    const result = await sweepUndraftedIdeas({ anthropicApiKey: "" });
    expect(result).toEqual({ structured: 0, flagged: 0, skipped: 0, failed: 0, errors: [] });
    expect(mockIdeaFindMany).not.toHaveBeenCalled();
  });

  it("structures a genuine draft and attributes the audit log to the Structuring Bot agent", async () => {
    const idea = makeIdea();
    mockIdeaFindMany.mockResolvedValue([idea]);
    mockIdeaFindUnique.mockResolvedValue(idea);

    const result = await sweepUndraftedIdeas({ anthropicApiKey: "test-key" });

    expect(result.structured).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockIdeaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "idea_1" },
        data: expect.objectContaining({ description: expect.stringContaining("## Summary") }),
      }),
    );
    expect(mockAudit).toHaveBeenCalledWith(
      { agentId: AGENT.id, tenantId: AGENT.tenantId },
      "idea.structured",
      "idea:idea_1",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("flags a too-thin draft without calling the model or writing anything", async () => {
    const idea = makeIdea({ description: "fix bug" });
    mockIdeaFindMany.mockResolvedValue([idea]);

    const result = await sweepUndraftedIdeas({ anthropicApiKey: "test-key" });

    expect(result.flagged).toBe(1);
    expect(result.structured).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockIdeaUpdate).not.toHaveBeenCalled();
  });

  it("skips rather than overwrites when the idea was structured by someone else since listing", async () => {
    const idea = makeIdea();
    mockIdeaFindMany.mockResolvedValue([idea]);
    // Re-fetch right before writing shows it's already structured now.
    mockIdeaFindUnique.mockResolvedValue({
      ...idea,
      description: "## Summary\nAlready done\n\n## Problem Statement\n...\n\n## Acceptance Criteria\n- [ ] done",
    });

    const result = await sweepUndraftedIdeas({ anthropicApiKey: "test-key" });

    expect(result.skipped).toBe(1);
    expect(result.structured).toBe(0);
    expect(mockIdeaUpdate).not.toHaveBeenCalled();
  });

  it("fails one idea without aborting the rest of the run, when no Structuring Bot agent exists for its tenant", async () => {
    const idea = makeIdea();
    mockIdeaFindMany.mockResolvedValue([idea]);
    mockAgentFindFirst.mockResolvedValue(null);

    const result = await sweepUndraftedIdeas({ anthropicApiKey: "test-key" });

    expect(result.failed).toBe(1);
    expect(result.errors[0]).toEqual(
      expect.objectContaining({ ideaId: "idea_1", error: expect.stringContaining("Structuring Bot") }),
    );
    expect(mockIdeaUpdate).not.toHaveBeenCalled();
  });

  it("bounds a run to `limit` ideas even when more are pending", async () => {
    await sweepUndraftedIdeas({ anthropicApiKey: "test-key", limit: 3 });
    expect(mockIdeaFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 6 }), // limit * 2, over-fetched before the isUnstructuredDraft() filter
    );
  });
});
