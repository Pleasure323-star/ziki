// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuditLog, type AuditLogRow } from "./audit-log";
import { ToastProvider } from "@/components/ui/toast";

const row = (overrides: Partial<AuditLogRow>): AuditLogRow => ({
  id: "event-1",
  createdAt: "2026-10-19T10:00:00Z",
  agentName: "Triage bot",
  action: "commented",
  target: "#42 Login button overlaps",
  issueHref: "/issues/42",
  agentId: "agent-1",
  bugId: "bug-42",
  payload: { body: "secret-payload-1" },
  undoneAt: null,
  ...overrides,
});

describe("AuditLog (#447)", () => {
  beforeEach(() => cleanup());

  it("loads with every row collapsed", () => {
    render(<AuditLog rows={[row({}), row({ id: "event-2", payload: { body: "secret-payload-2" } })]} />);
    expect(screen.queryByText(/secret-payload/)).not.toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "Show more" })) {
      expect(button).toHaveAttribute("aria-expanded", "false");
    }
  });

  it("reveals the payload for that row only", async () => {
    const user = userEvent.setup({ delay: null });
    render(<AuditLog rows={[row({}), row({ id: "event-2", payload: { body: "secret-payload-2" } })]} />);

    await user.click(screen.getAllByRole("button", { name: "Show more" })[0]);

    expect(screen.getByText(/secret-payload-1/)).toBeInTheDocument();
    expect(screen.queryByText(/secret-payload-2/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  });

  it("collapses again on Show less", async () => {
    const user = userEvent.setup({ delay: null });
    render(<AuditLog rows={[row({})]} />);
    await user.click(screen.getByRole("button", { name: "Show more" }));
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByText(/secret-payload-1/)).not.toBeInTheDocument();
  });

  it("opens from the keyboard without navigating", async () => {
    const user = userEvent.setup({ delay: null });
    render(<AuditLog rows={[row({})]} />);
    await user.tab(); // the issue link
    await user.tab(); // the Show more button
    expect(screen.getByRole("button", { name: "Show more" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByText(/secret-payload-1/)).toBeInTheDocument();
  });

  it("links the row to its issue", () => {
    render(<AuditLog rows={[row({})]} />);
    expect(screen.getByRole("link", { name: "#42 Login button overlaps" })).toHaveAttribute("href", "/issues/42");
  });

  it("marks an undone event", () => {
    render(<AuditLog rows={[row({ undoneAt: "2026-10-19T11:00:00Z" })]} />);
    expect(screen.getByText("Undone")).toBeInTheDocument();
  });

  it("shows the server's message when the undo is refused", async () => {
    const user = userEvent.setup({ delay: null });
    const onUndo = vi.fn().mockResolvedValue({
      ok: false,
      error: "You can't undo an action performed by your own agent.",
    });
    render(
      <ToastProvider>
        <AuditLog rows={[row({})]} isTenantAdmin onUndo={onUndo} />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Undo" }));

    expect(
      await screen.findByText("You can't undo an action performed by your own agent."),
    ).toBeInTheDocument();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

});
