import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  currentTenantIdFor: vi.fn(),
  listOwnerQuestions: vi.fn(),
  findMany: vi.fn(),
}));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/tenant-context", () => ({ currentTenantIdFor: mocks.currentTenantIdFor }));
vi.mock("@/lib/prisma", () => ({ prisma: { redesignProposal: { findMany: mocks.findMany } } }));
vi.mock("@/lib/agent-questions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-questions")>()),
  listOwnerQuestions: mocks.listOwnerQuestions,
}));
vi.mock("./escalation-controls", () => ({
  EscalationTypeBadge: ({ type }: { type: string }) => type,
  QuickResolveButtons: () => null,
}));

import EscalationsPage from "./page";

const at = (day: number) => new Date(Date.UTC(2026, 9, day, 10));

describe("EscalationsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
    mocks.currentTenantIdFor.mockResolvedValue("tenant-1");
    mocks.listOwnerQuestions.mockResolvedValue([
      { id: "q-1", body: "[Question] Which locale?", answer: null, answeredAt: null, bugId: "b", createdAt: at(20), agent: { id: "a", name: "Helper" }, bug: { id: "b", number: 42, title: "Login broken" } },
      { id: "q-2", body: "[Blocker] Need a key", answer: "Use the test key", answeredAt: at(19), bugId: null, createdAt: at(18), agent: { id: "a", name: "Helper" }, bug: null },
    ]);
    mocks.findMany.mockResolvedValue([
      { id: "r-1", title: "New header", body: "Move the bell", status: "proposed", createdAt: at(21), bug: null, authorAgent: { name: "Designer" } },
    ]);
  });

  const render = async (status?: string) =>
    renderToStaticMarkup(await EscalationsPage({ searchParams: Promise.resolve(status ? { status } : {}) })).replace(/<!-- -->/g, "");

  it("lists what waits on you: agent questions and redesign proposals, newest first", async () => {
    const html = await render();
    expect(html).toContain("New header");
    expect(html).toContain("Which locale?");
    expect(html).not.toContain("Need a key");
    expect(html.indexOf("New header")).toBeLessThan(html.indexOf("Which locale?"));
    expect(html).toContain('href="/issues/42"');
    expect(html).toMatch(/aria-current="page"[^>]*>Waiting<span[^>]*>2</);
  });

  it("shows resolved questions with your answer", async () => {
    const html = await render("resolved");
    expect(html).toContain("Need a key");
    expect(html).toContain("Use the test key");
    expect(html).not.toContain("Which locale?");
  });
});
