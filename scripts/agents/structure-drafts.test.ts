import { describe, expect, it, vi } from "vitest";
import {
  buildExtractionPrompt,
  fetchIssue,
    isTooThinToStructure,
  listDrafts,
  parseExtraction,
  run,
  structureDraft,
  type DraftIssue,
} from "./structure-drafts";

const BASE = "https://ziki.test";

type Call = { method: string; path: string; search: string; body: unknown };

/** Replies per "METHOD /path". The last reply for a route repeats, same convention as scripts/ziki-agent.test.ts. */
function fakeApi(routes: Record<string, unknown[]>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      search: url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const key = `${method} ${url.pathname}`;
    const queue = routes[key];
    if (!queue?.length) throw new Error(`unexpected request: ${key}`);
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function draft(overrides: Partial<DraftIssue> = {}): DraftIssue {
  return {
    id: "bug-1",
    number: 101,
    title: "Add dark mode toggle",
    description: "Can we add a dark mode toggle to the top right of the navigation?",
    status: "open",
    createdByAgentId: null,
    ...overrides,
  };
}

const STRUCTURED_DESCRIPTION =
  "## Summary\nAlready structured.\n\n## Problem Statement\nX\n\n## Proposed Solution\nY\n\n## Acceptance Criteria\n- [ ] Z";

function baseDeps(fetchImpl: typeof fetch) {
  return {
    zikiBaseUrl: BASE,
    zikiAgentKey: "test-key",
    anthropicApiKey: "test-anthropic-key",
    anthropicModel: "claude-sonnet-4-5",
    fetchImpl,
  };
}

describe("isTooThinToStructure", () => {
  it("flags an unfilled template as too thin", () => {
    const template = "Steps to reproduce\n\n1.\n2.\n3.\n\nExpected\nActual\nEnvironment\nBrowser / app version:\nDevice and OS:";
    expect(isTooThinToStructure(template)).toBe(true);
  });

  it("flags a bare one-liner as too thin", () => {
    expect(isTooThinToStructure("I am too good")).toBe(true);
  });

  it("does not flag a real draft with actual content", () => {
    expect(isTooThinToStructure("Can we add a dark mode toggle to the top right of the navigation?")).toBe(false);
  });
});

describe("parseExtraction", () => {
  it("parses a well-formed model response", () => {
    const text = '{"summary": "Dark mode toggle", "problem": "No dark mode.", "proposedSolution": "Add a toggle.", "acceptanceCriteria": ["Toggle exists", "Persists across sessions"]}';
    expect(parseExtraction(text)).toEqual({
      summary: "Dark mode toggle",
      problem: "No dark mode.",
      proposedSolution: "Add a toggle.",
      acceptanceCriteria: ["Toggle exists", "Persists across sessions"],
    });
  });

  it("extracts JSON even when the model wraps it in prose or fences", () => {
    const text = 'Sure, here you go:\n```json\n{"summary": "S", "problem": "P", "proposedSolution": "Sol", "acceptanceCriteria": ["A"]}\n```';
    expect(parseExtraction(text).summary).toBe("S");
  });

  it("throws when the model output has no JSON", () => {
    expect(() => parseExtraction("I cannot help with that.")).toThrow();
  });

  it("throws when a required field is missing or the wrong type", () => {
    const text = '{"summary": "S", "problem": "P", "proposedSolution": "Sol"}';
    expect(() => parseExtraction(text)).toThrow();
  });
});

describe("buildExtractionPrompt", () => {
  it("includes the issue title and description verbatim", () => {
    const prompt = buildExtractionPrompt({ title: "My Title", description: "My description text." });
    expect(prompt).toContain("My Title");
    expect(prompt).toContain("My description text.");
  });
});

describe("listDrafts", () => {
  it("keeps only human-authored, unstructured, open drafts and follows cursors", async () => {
    const page1 = {
      items: [
        draft({ id: "a", number: 1, description: "Raw human idea with no headings yet." }),
        draft({ id: "b", number: 2, createdByAgentId: "agent-1" }), // agent-authored — excluded
        draft({ id: "c", number: 3, description: STRUCTURED_DESCRIPTION }), // already structured — excluded
      ],
      nextCursor: "cursor-2",
    };
    const page2 = {
      items: [draft({ id: "d", number: 4, description: "Second page raw idea." })],
      nextCursor: null,
    };
    const { fetchImpl, calls } = fakeApi({ "GET /api/v1/ideas": [page1, page2] });

    const result = await listDrafts(baseDeps(fetchImpl));

    expect(result.map((d) => d.id)).toEqual(["a", "d"]);
    expect(calls).toHaveLength(2);
    expect(calls[1].search).toContain("cursor=cursor-2");
  });
});

describe("fetchIssue", () => {
  it("fetches a single idea by id", async () => {
    const { fetchImpl, calls } = fakeApi({ "GET /api/v1/ideas/bug-1": [{ idea: draft() }] });

    const result = await fetchIssue(baseDeps(fetchImpl), "bug-1");

    expect(result.id).toBe("bug-1");
    expect(calls[0].path).toBe("/api/v1/ideas/bug-1");
  });
});

describe("structureDraft", () => {
  const fields = { summary: "S", problem: "P", proposedSolution: "Sol", acceptanceCriteria: ["A", "B"] };

  it("re-checks the draft, then posts the extracted fields to /structure; ideas take no comments", async () => {
    const { fetchImpl, calls } = fakeApi({
      "GET /api/v1/ideas/bug-1": [{ idea: draft() }], // still unstructured as of the re-check
      "POST /api/v1/ideas/bug-1/structure": [{ ok: true, idea: { id: "bug-1" } }],
    });

    const outcome = await structureDraft(baseDeps(fetchImpl), draft(), fields);

    expect(outcome).toBe("structured");
    expect(calls[0].path).toBe("/api/v1/ideas/bug-1");
    expect(calls[1].path).toBe("/api/v1/ideas/bug-1/structure");
    expect(calls[1].body).toMatchObject({ summary: "S" });
    expect(calls).toHaveLength(2);
  });

  it("skips without writing when the draft was already structured since it was listed", async () => {
    const { fetchImpl, calls } = fakeApi({
      "GET /api/v1/ideas/bug-1": [{ idea: draft({ description: STRUCTURED_DESCRIPTION }) }],
    });

    const outcome = await structureDraft(baseDeps(fetchImpl), draft(), fields);

    expect(outcome).toBe("skipped_already_structured");
    expect(calls).toHaveLength(1); // only the re-check — no /structure
  });

});

describe("run", () => {
  it("structures real drafts and flags thin ones, tolerating per-issue failures", async () => {
    const real = draft({ id: "real-1", number: 10, description: "A real, substantive draft idea with enough detail." });
    const thin = draft({ id: "thin-1", number: 11, description: "too short" });
    const broken = draft({ id: "broken-1", number: 12, description: "Another substantive draft that will fail to structure." });

    const { fetchImpl } = fakeApi({
      "GET /api/v1/ideas": [{ items: [real, thin, broken], nextCursor: null }],
      "GET /api/v1/ideas/real-1": [{ idea: real }], // structureDraft's re-check — still unstructured
      "POST /api/v1/ideas/real-1/structure": [{ ok: true }],
    });

    // Anthropic calls go through the same fetchImpl; stub them separately.
    const anthropicResponses = [
      // real-1
      { content: [{ text: '{"summary":"S","problem":"P","proposedSolution":"Sol","acceptanceCriteria":["A"]}' }] },
      // broken-1: malformed, no JSON at all -> extractFields throws before structureDraft is ever called
      { content: [{ text: "no json here" }] },
    ];
    const wrappedFetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.anthropic.com")) {
        const reply = anthropicResponses.shift();
        return new Response(JSON.stringify(reply), { status: 200 });
      }
      return fetchImpl(input as never, init);
    }) as unknown as typeof fetch;

    const result = await run(baseDeps(wrappedFetch), { dryRun: false });

    expect(result).toEqual({ total: 3, structured: 1, flagged: 1, skipped: 0, failed: 1 });
  });

  it("counts a draft that was already structured by the time of the write as skipped, not structured", async () => {
    const real = draft({ id: "real-1", number: 10, description: "A real, substantive draft idea with enough detail." });

    const { fetchImpl } = fakeApi({
      "GET /api/v1/ideas": [{ items: [real], nextCursor: null }],
      "GET /api/v1/ideas/real-1": [{ idea: draft({ id: "real-1", description: STRUCTURED_DESCRIPTION }) }], // structured out from under us
    });
    const wrappedFetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.anthropic.com")) {
        return new Response(
          JSON.stringify({ content: [{ text: '{"summary":"S","problem":"P","proposedSolution":"Sol","acceptanceCriteria":["A"]}' }] }),
          { status: 200 },
        );
      }
      return fetchImpl(input as never, init);
    }) as unknown as typeof fetch;

    const result = await run(baseDeps(wrappedFetch), { dryRun: false });

    expect(result).toEqual({ total: 1, structured: 0, flagged: 0, skipped: 1, failed: 0 });
  });

  it("dry run never calls structure or re-check endpoints", async () => {
    const real = draft({ id: "real-1", number: 10, description: "A real, substantive draft idea with enough detail." });
    const { fetchImpl, calls } = fakeApi({ "GET /api/v1/ideas": [{ items: [real], nextCursor: null }] });
    const wrappedFetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.anthropic.com")) {
        return new Response(
          JSON.stringify({ content: [{ text: '{"summary":"S","problem":"P","proposedSolution":"Sol","acceptanceCriteria":["A"]}' }] }),
          { status: 200 },
        );
      }
      return fetchImpl(input as never, init);
    }) as unknown as typeof fetch;

    const result = await run(baseDeps(wrappedFetch), { dryRun: true });

    expect(result).toEqual({ total: 1, structured: 1, flagged: 0, skipped: 0, failed: 0 });
    expect(calls.every((c) => c.path === "/api/v1/ideas")).toBe(true);
  });
});
