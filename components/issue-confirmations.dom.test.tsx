// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/issues", () => ({ addCommentAction: vi.fn() }));
vi.mock("@/app/actions/confirmations", () => ({ giveConfirmationAction: vi.fn() }));

import { IssueConfirmationsPanel, type ConfirmationEntryView, type ConfirmationsData } from "./issue-confirmations";

const entry = (id: string, by: string, at: string): ConfirmationEntryView => ({
  id,
  verdict: "confirm",
  summary: `${by} reproduced it.`,
  description: `${by}'s steps and what happened.`,
  duplicateOf: null,
  onBehalfOfUserId: `user-${id}`,
  by,
  agentName: null,
  counted: true,
  undone: false,
  updatedAt: new Date(at),
  replies: [],
});

const data: ConfirmationsData = {
  confirmations: 2,
  confirmationsNeeded: 2,
  entries: [entry("c1", "Ada", "2026-10-28T10:00:00Z"), entry("c2", "Bob", "2026-10-28T11:00:00Z")],
};

afterEach(() => cleanup());

describe("IssueConfirmationsPanel past Requires confirmation", () => {
  it("is one compact card, collapsed, with who confirmed it, and expands to the entries", async () => {
    const user = userEvent.setup({ delay: null });
    render(<IssueConfirmationsPanel bugId="bug1" data={data} viewerId="viewer" block={null} summaryMaxChars={200} history confirmed />);
    const card = screen.getByTestId("confirmations-collapsed");
    expect(card.tagName).toBe("DETAILS");
    expect(card).not.toHaveAttribute("open");
    expect(card).toHaveTextContent("Confirmed by Ada, Bob");
    // A quiet gray check marks it.
    expect(screen.getByTestId("confirmations-collapsed-icon").getAttribute("class")).toContain("text-zk-muted");
    // No big banner while it is collapsed.
    expect(screen.queryByTestId("confirmation-banner")).toBeNull();
    await user.click(screen.getByText("Confirmations"));
    expect(card).toHaveAttribute("open");
    expect(screen.getByText("Ada reproduced it.")).toBeVisible();
  });

  it("shows the full cards, and no Not confirmed banner, while the issue requires confirmation", () => {
    render(<IssueConfirmationsPanel bugId="bug1" data={data} viewerId="viewer" block={null} summaryMaxChars={200} confirmed={false} />);
    expect(screen.queryByTestId("confirmations-collapsed")).toBeNull();
    expect(screen.getByText("Ada reproduced it.")).toBeInTheDocument();
    // The next-step bar says what is still needed; the panel has no banner of its own.
    expect(screen.queryByTestId("confirmation-banner")).toBeNull();
    expect(screen.queryByText(/Not confirmed yet/)).toBeNull();
  });

  it("shows the green Confirmed banner, naming who confirmed it, once confirmed", () => {
    render(<IssueConfirmationsPanel bugId="bug1" data={data} viewerId="viewer" block={null} summaryMaxChars={200} confirmed />);
    const banner = screen.getByTestId("confirmation-banner");
    expect(banner).toHaveAttribute("data-confirmed", "true");
    expect(banner).toHaveTextContent("Confirmed");
    expect(banner).toHaveTextContent("By Ada, Bob");
  });
});
