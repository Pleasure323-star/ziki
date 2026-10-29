// @vitest-environment happy-dom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const openDisputeAction = vi.hoisted(() => vi.fn());
vi.mock("@/app/(app)/points/disputes/actions", () => ({ openDisputeAction }));

import { DisputeAwardDialog } from "./dispute-award-dialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Dispute award (#entry-replies-only)", () => {
  it("is not offered to someone with no award to dispute", () => {
    render(<DisputeAwardDialog bugNumber={7} roles={[]} />);
    expect(screen.queryByRole("button", { name: "Dispute award" })).toBeNull();
  });

  it("has its own button, and opens a missing-award dispute, never a comment", async () => {
    openDisputeAction.mockResolvedValue({ ok: true, message: "Dispute opened. A workspace admin will review it." });
    render(<DisputeAwardDialog bugNumber={7} roles={["solver", "reporter"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Dispute award" }));
    fireEvent.change(screen.getByLabelText("Missing award"), { target: { value: "reporter" } });
    fireEvent.change(screen.getByLabelText("What's missing?"), { target: { value: "No reporter points appeared." } });
    fireEvent.click(screen.getByRole("button", { name: "Open dispute" }));
    await waitFor(() => expect(openDisputeAction).toHaveBeenCalledTimes(1));
    const sent = openDisputeAction.mock.calls[0][1] as FormData;
    expect(Object.fromEntries(sent)).toEqual({ bugNumber: "7", kind: "missing", role: "reporter", reason: "No reporter points appeared." });
  });

  it("shows the dispute's error", async () => {
    openDisputeAction.mockResolvedValue({ ok: false, error: "You already disputed this award." });
    render(<DisputeAwardDialog bugNumber={7} roles={["solver"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Dispute award" }));
    expect(screen.queryByLabelText("Missing award")).toBeNull();
    fireEvent.change(screen.getByLabelText("What's missing?"), { target: { value: "Missing again." } });
    fireEvent.click(screen.getByRole("button", { name: "Open dispute" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You already disputed this award.");
  });
});
