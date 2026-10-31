// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const markAllRead = vi.hoisted(() => vi.fn());
vi.mock("@/app/actions/notifications", () => ({ markAllNotificationsReadAction: markAllRead }));

import { MarkAllReadButton } from "./mark-all-read-button";

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("MarkAllReadButton", () => {
  it("shows an error and keeps the button available when the action rejects", async () => {
    const user = userEvent.setup({ delay: null });
    markAllRead.mockRejectedValueOnce(new Error("database unavailable"));
    render(<MarkAllReadButton />);

    await user.click(screen.getByRole("button", { name: "Mark all as read" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark all as read" })).toBeEnabled();
  });
});
