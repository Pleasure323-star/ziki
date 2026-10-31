// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/app/actions/settings", () => ({
  setThemeAction: vi.fn(),
}));

import { setThemeAction } from "@/app/actions/settings";
import { ThemeSettings } from "./theme-settings";

const mockSave = vi.mocked(setThemeAction);

describe("ThemeSettings save feedback (#646)", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    document.documentElement.removeAttribute("data-theme");
  });

  it("shows a failed save as an alert and reverts the choice", async () => {
    mockSave.mockResolvedValueOnce({ error: "Could not save theme to your account." });
    const user = userEvent.setup({ delay: null });
    render(<ThemeSettings initialTheme="light" />);

    await user.click(screen.getByRole("radio", { name: /Dark/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not save theme to your account.");
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(screen.getByRole("radio", { name: /Dark/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /Light/ })).toBeChecked();
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("shows success as a status and clears an earlier error", async () => {
    mockSave
      .mockResolvedValueOnce({ error: "Could not save theme to your account." })
      .mockResolvedValueOnce({ ok: true });
    const user = userEvent.setup({ delay: null });
    render(<ThemeSettings initialTheme="light" />);
    const dark = screen.getByRole("radio", { name: /Dark/ });

    await user.click(dark);
    await screen.findByRole("alert");

    await user.click(dark);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/dark/i),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(dark).toBeChecked();
  });
});
