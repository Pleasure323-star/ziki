import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), tenant: vi.fn(), load: vi.fn(), enabled: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/tenant-context", () => ({ currentTenantIdFor: mocks.tenant }));
vi.mock("@/lib/agent-center/queries", () => ({ loadAgentCenter: mocks.load }));
vi.mock("@/lib/feature-flags", () => ({ isAgentPlatformEnabled: mocks.enabled }));
vi.mock("@/components/local-time", () => ({ LocalTime: () => <time>Today</time> }));
vi.mock("@/app/(app)/inbox/escalation-controls", () => ({
  EscalationTypeBadge: ({ type }: { type: string }) => <span>{type}</span>,
  QuickResolveButtons: ({ escalationId }: { escalationId: string }) => <button>Respond {escalationId}</button>,
}));
vi.mock("@/lib/agent-questions", () => ({ parseEscalationBody: (body: string) => ({ type: "Blocker", cleanBody: body }) }));
import ActivityPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "u1" });
  mocks.tenant.mockResolvedValue("t1");
  mocks.enabled.mockReturnValue(true);
  const empty = { items: [], next: null };
  mocks.load.mockResolvedValue({ isAdmin: false, questions: empty, work: empty, events: empty });
});

it("authenticates before querying, including when the feature is disabled", async () => {
  mocks.requireUser.mockRejectedValue(new Error("Sign in"));
  mocks.enabled.mockReturnValue(false);
  await expect(ActivityPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("Sign in");
  expect(mocks.load).not.toHaveBeenCalled();
});

it("passes only session identity and current tenant to the query", async () => {
  await ActivityPage({ searchParams: Promise.resolve({ issue: "123" }) });
  expect(mocks.load).toHaveBeenCalledWith("u1", "t1", { issue: "123" });
});

it("handles members without a workspace without showing activity", async () => {
  mocks.load.mockResolvedValue(null);
  const html = renderToStaticMarkup(await ActivityPage({ searchParams: Promise.resolve({}) }));
  expect(html).not.toContain("Work History");
});

it("renders issue/PR links and paging for work history", async () => {
  mocks.load.mockResolvedValue({
    isAdmin: true, questions: { items: [], next: null }, events: { items: [], next: null },
    work: { items: [{ id: "c1", createdAt: new Date(), status: "active", agent: { name: "Ada's agent" }, deliverBy: null, waitingOnOwnerSince: null, releasedAt: null, releaseReason: null, lastHeartbeatAt: null, bug: { id: "bug1", number: 42, title: "Fix", status: "in_progress", pullRequestUrl: "https://github.com/org/repo/pull/1", project: { slug: "ziki" } } }], next: "older" },
  });
  const html = renderToStaticMarkup(await ActivityPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('href="/ziki/42"');
  expect(html).toContain('https://github.com/org/repo/pull/1');
  expect(html).not.toContain("Pipeline approvals");
  expect(html).toContain("work=older");
  expect(html).not.toContain("undefined");
});

it("shows claim deadlines, owner blockers and audit timestamps with issue links", async () => {
  const at = new Date("2026-10-27T12:00:00Z");
  const bug = { id: "b1", number: 9, title: "Login", status: "in_progress", pullRequestUrl: null, project: { slug: "ziki" } };
  mocks.load.mockResolvedValue({
    isAdmin: false, questions: { items: [], next: null },
    work: { items: [{ id: "c1", createdAt: at, status: "active", agent: { name: "Ada's agent" }, bug, deliverBy: at, waitingOnOwnerSince: at, releasedAt: null, releaseReason: null, lastHeartbeatAt: at }], next: null },
    events: { items: [{ id: "e1", createdAt: at, action: "issue.claimed", agent: { name: "Ada's agent" }, bug, undoneAt: null }], next: null },
  });
  const html = renderToStaticMarkup(await ActivityPage({ searchParams: Promise.resolve({}) }));
  for (const text of ["issue.claimed", 'href="/ziki/9"', "<time>Today</time>"]) expect(html).toContain(text);
  expect(html).toMatch(/in progress/i);
  expect(html).toMatch(/waiting for owner/i);
});
