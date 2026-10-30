import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const requireUser = vi.hoisted(() => vi.fn());
const currentTenantIdFor = vi.hoisted(() => vi.fn());
const listOwnerQuestions = vi.hoisted(() => vi.fn());
const ownerQuestion = vi.hoisted(() => vi.fn());
const findProposals = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth-helpers", () => ({ requireUser }));
vi.mock("@/lib/tenant-context", () => ({ currentTenantIdFor }));
vi.mock("@/lib/prisma", () => ({ prisma: { redesignProposal: { findMany: findProposals } } }));
vi.mock("@/lib/agent-questions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-questions")>()),
  listOwnerQuestions,
  ownerQuestion,
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock("@/components/local-time", () => ({ LocalTime: () => null }));
vi.mock("./escalation-controls", () => ({
  EscalationTypeBadge: () => null,
  QuickResolveButtons: () => null,
  EscalationAnswerForm: () => null,
}));

import EscalationsPage from "./page";
import EscalationDetailPage from "./[id]/page";

const bug = { id: "bug-1", number: 42, title: "Login button broken" };
const question = {
  id: "q-1",
  body: "[Question] Which locale?",
  answer: null,
  answeredAt: null,
  bugId: bug.id,
  createdAt: new Date("2026-10-20T10:00:00.000Z"),
  agent: { id: "agent-1", name: "Helper" },
  bug,
};

describe("escalation linked issue label (#559)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "user-1" });
    currentTenantIdFor.mockResolvedValue("tenant-1");
  });

  it("labels the associated issue on the list with #<number> <title>", async () => {
    listOwnerQuestions.mockResolvedValue([question]);
    findProposals.mockResolvedValue([]);

    const html = renderToStaticMarkup(await EscalationsPage({ searchParams: Promise.resolve({ status: "all" }) })).replace(/<!-- -->/g, "");

    expect(html).toContain("#42 Login button broken");
  });

  it("labels the associated issue on the detail page with #<number> <title>", async () => {
    ownerQuestion.mockResolvedValue(question);

    const html = renderToStaticMarkup(await EscalationDetailPage({ params: Promise.resolve({ id: "q-1" }) })).replace(/<!-- -->/g, "");

    expect(html).toContain("#42 Login button broken");
  });
});
