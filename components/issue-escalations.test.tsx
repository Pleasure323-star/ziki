// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueEscalations, type TicketEscalation } from "./issue-escalations";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/app/(app)/inbox/actions", () => ({
  quickResolveEscalationAction: vi.fn(),
  answerEscalationAction: vi.fn(),
}));

afterEach(() => cleanup());

describe("IssueEscalations (#763)", () => {
  it("renders nothing when there are no escalations", () => {
    const { container } = render(<IssueEscalations escalations={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders active escalations with type badge and quick actions", () => {
    const escalations: TicketEscalation[] = [
      {
        id: "esc-1",
        body: "I am blocked by missing credentials for the deploy step.",
        answeredAt: null,
        createdAt: new Date(),
        agent: { name: "Agent Alpha" },
      },
      {
        id: "esc-2",
        body: "Please approve this design proposal before merge.",
        answeredAt: new Date(),
        answer: "Looks good, approved.",
        createdAt: new Date(),
        agent: { name: "Agent Beta" },
      },
    ];

    render(<IssueEscalations escalations={escalations} />);

    expect(screen.getByText(/\(2\)/)).toBeTruthy();
    expect(screen.getByText(/1 unresolved/i)).toBeTruthy();

    expect(screen.getByText("Agent Alpha")).toBeTruthy();
    expect(screen.getByText(/blocker/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /approve/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /authori[sz]e/i })).toBeTruthy();

    expect(screen.getByText("Agent Beta")).toBeTruthy();
    expect(screen.getByText(/human approval/i)).toBeTruthy();
    expect(screen.getByText("Looks good, approved.")).toBeTruthy();
  });
});
