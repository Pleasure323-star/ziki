// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IssueApprovalBanner } from "./issue-approval-banner";
import { QuickResolveButtons } from "@/app/(app)/inbox/escalation-controls";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), resolve: vi.fn(), fetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/app/(app)/inbox/actions", () => ({ quickResolveEscalationAction: mocks.resolve, answerEscalationAction: vi.fn() }));

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", mocks.fetch); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(["Approve", "Reject"])("reuses the pipeline endpoint and refreshes after %s", async (button) => {
  mocks.fetch.mockResolvedValue({ ok: true });
  render(<IssueApprovalBanner approval={{ id: "a1", stage: "before_offer", status: "pending" }} canDecide />);
  await userEvent.click(screen.getByRole("button", { name: button }));
  expect(mocks.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/v1/approvals/a1/decision"), expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: button === "Approve" ? "approved" : "rejected" }) }));
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it("shows already-decided errors without refreshing and permits retry", async () => {
  mocks.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "This approval has already been approved." }) }).mockResolvedValueOnce({ ok: true });
  render(<IssueApprovalBanner approval={{ id: "a1", stage: "before_merge", status: "pending" }} canDecide />);
  await userEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect((await screen.findByRole("alert")).textContent).toContain("already been approved");
  expect(mocks.refresh).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("handles pipeline network errors", async () => {
  mocks.fetch.mockRejectedValue(new Error("Network unavailable"));
  render(<IssueApprovalBanner approval={{ id: "a1", stage: "before_merge", status: "pending" }} canDecide />);
  await userEvent.click(screen.getByRole("button", { name: "Reject" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Network unavailable");
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it("does not render decision buttons without permission", () => {
  render(<IssueApprovalBanner approval={{ id: "a1", stage: "before_offer", status: "pending" }} canDecide={false} />);
  expect(screen.queryByRole("button")).toBeNull();
});

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
