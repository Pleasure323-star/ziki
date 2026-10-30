// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EscalationTypeBadge,
  QuickResolveButtons,
  EscalationAnswerForm,
} from "@/app/(app)/escalations/escalation-controls";
import { quickResolveEscalationAction } from "@/app/(app)/escalations/actions";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/app/(app)/escalations/actions", () => ({
  quickResolveEscalationAction: vi.fn(),
  answerEscalationAction: vi.fn(),
}));

afterEach(() => cleanup());

describe("EscalationTypeBadge (#763)", () => {
  it("renders distinct badge labels", () => {
    const { rerender } = render(<EscalationTypeBadge type="Blocker" />);
    expect(screen.getByText("Blocker")).toBeTruthy();

    rerender(<EscalationTypeBadge type="Work Authorization" />);
    expect(screen.getByText("Work Authorization")).toBeTruthy();

    rerender(<EscalationTypeBadge type="Human Approval" />);
    expect(screen.getByText("Human Approval")).toBeTruthy();
  });
});

describe("QuickResolveButtons (#763)", () => {
  it("triggers quick resolve action with approve", async () => {
    const user = userEvent.setup({ delay: null });
    const mockAction = vi.mocked(quickResolveEscalationAction);
    mockAction.mockResolvedValue({ ok: true });

    render(<QuickResolveButtons escalationId="esc-123" />);

    const approveBtn = screen.getByRole("button", { name: /approve & unblock/i });
    await user.click(approveBtn);

    expect(mockAction).toHaveBeenCalledWith("esc-123", "approve");
  });

  it("triggers quick resolve action with authorize", async () => {
    const user = userEvent.setup({ delay: null });
    const mockAction = vi.mocked(quickResolveEscalationAction);
    mockAction.mockResolvedValue({ ok: true });

    render(<QuickResolveButtons escalationId="esc-123" />);

    const authBtn = screen.getByRole("button", { name: /authorize work/i });
    await user.click(authBtn);

    expect(mockAction).toHaveBeenCalledWith("esc-123", "authorize");
  });
});

describe("QuickResolveButtons refused action (Ziki #538)", () => {
  it("shows the server's error as an alert and does not report it resolved", async () => {
    const user = userEvent.setup({ delay: null });
    const onResolved = vi.fn();
    vi.mocked(quickResolveEscalationAction).mockResolvedValue({
      ok: false,
      error: "This question was already answered.",
    });

    render(<QuickResolveButtons escalationId="esc-123" onResolved={onResolved} />);
    expect(screen.queryByRole("alert")).toBeNull();

    await user.click(screen.getByRole("button", { name: /approve & unblock/i }));

    expect((await screen.findByRole("alert")).textContent).toBe("This question was already answered.");
    expect(onResolved).not.toHaveBeenCalled();
    // The error is set inside the transition, so the alert can show while the
    // button is still pending ("Unblocking…"); wait for the transition to end.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /approve & unblock/i })).toHaveProperty("disabled", false),
    );
  });

  it("clears the error when a retry succeeds", async () => {
    const user = userEvent.setup({ delay: null });
    const onResolved = vi.fn();
    vi.mocked(quickResolveEscalationAction)
      .mockResolvedValueOnce({ ok: false, error: "You can't answer this escalation." })
      .mockResolvedValueOnce({ ok: true });

    render(<QuickResolveButtons escalationId="esc-123" onResolved={onResolved} />);

    await user.click(screen.getByRole("button", { name: /authorize work/i }));
    expect(await screen.findByRole("alert")).toBeTruthy();

    // Retry once the first transition has ended; a pending button ignores the click.
    const retry = screen.getByRole("button", { name: /authorize work/i });
    await waitFor(() => expect(retry).toHaveProperty("disabled", false));
    await user.click(retry);
    await vi.waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("EscalationAnswerForm (#763)", () => {
  it("renders textarea and submit button", () => {
    render(<EscalationAnswerForm escalationId="esc-456" />);

    expect(screen.getByPlaceholderText(/provide decision/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /send response/i })).toBeTruthy();
  });
});
