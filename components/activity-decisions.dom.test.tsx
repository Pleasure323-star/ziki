// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuickResolveButtons } from "@/app/(app)/inbox/escalation-controls";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), resolve: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/app/(app)/inbox/actions", () => ({ quickResolveEscalationAction: mocks.resolve, answerEscalationAction: vi.fn() }));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

it("refreshes after owner responses and displays refused responses", async () => {
  mocks.resolve.mockResolvedValueOnce({ ok: false, error: "Only the owner can answer this question." }).mockResolvedValueOnce({ ok: true });
  render(<QuickResolveButtons escalationId="q1" />);
  await userEvent.click(screen.getByRole("button", { name: /authorize work/i }));
  expect((await screen.findByRole("alert")).textContent).toContain("Only the owner");
  expect(mocks.refresh).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: /authorize work/i }));
  expect(mocks.resolve).toHaveBeenLastCalledWith("q1", "authorize");
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it("handles rejected escalation requests without refreshing", async () => {
  mocks.resolve.mockRejectedValue(new Error("Connection lost"));
  render(<QuickResolveButtons escalationId="q1" />);
  await userEvent.click(screen.getByRole("button", { name: /authorize work/i }));
  expect((await screen.findByRole("alert")).textContent).not.toBe("");
  expect(mocks.refresh).not.toHaveBeenCalled();
});
