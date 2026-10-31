// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setThemeAction } from "@/app/actions/settings";
import { ThemePreference, ThemeToggle, AccountThemeSelector, applyThemeClient } from "./theme-toggle";

vi.mock("@/app/actions/settings", () => ({
  setThemeAction: vi.fn(),
}));

const mockSetThemeAction = vi.mocked(setThemeAction);

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
});

beforeEach(() => {
  mockSetThemeAction.mockReset();
  mockSetThemeAction.mockResolvedValue({ ok: true });
});

describe("applyThemeClient (#659)", () => {
  it("sets data-theme attribute on documentElement and syncs localStorage", () => {
    applyThemeClient("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("theme")).toBe("dark");

    applyThemeClient("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("theme")).toBe("light");

    applyThemeClient("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("system");
  });
});

describe("ThemeToggle (#659)", () => {
  it("server markup follows the saved theme, not the device", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    document.documentElement.removeAttribute("data-theme");
    const systemHtml = renderToString(
      <ThemePreference theme="system">
        <ThemeToggle />
      </ThemePreference>,
    );
    expect(systemHtml).toMatch(/to dark/i);

    document.documentElement.setAttribute("data-theme", "dark");
    const darkHtml = renderToString(
      <ThemePreference theme="dark">
        <ThemeToggle />
      </ThemePreference>,
    );
    expect(darkHtml).toMatch(/to light/i);
  });

  it("renders with accessible button label", () => {
    render(<ThemeToggle />);
    const button = screen.getByTestId("theme-toggle");
    expect(button).toBeTruthy();
    expect(button.getAttribute("aria-label")).toMatch(/dark|light/i);
  });

  it("toggles to dark mode when currently light", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    const user = userEvent.setup({ delay: null });
    render(<ThemeToggle />);

    const button = screen.getByTestId("theme-toggle");
    expect(button.getAttribute("aria-label")).toMatch(/to dark/i);

    await user.click(button);

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(mockSetThemeAction).toHaveBeenCalledWith("dark");
  });

  it("toggles to light mode when currently dark", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const user = userEvent.setup({ delay: null });
    render(<ThemeToggle />);

    const button = screen.getByTestId("theme-toggle");
    expect(button.getAttribute("aria-label")).toMatch(/to light/i);

    await user.click(button);

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("theme")).toBe("light");
    expect(mockSetThemeAction).toHaveBeenCalledWith("light");
  });

  it("rolls back theme on server action failure", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    mockSetThemeAction.mockResolvedValueOnce({ error: "Failed to save" });
    const user = userEvent.setup({ delay: null });
    render(<ThemeToggle />);

    const button = screen.getByTestId("theme-toggle");
    await user.click(button);

    expect(mockSetThemeAction).toHaveBeenCalledWith("dark");
    // Wait for promise resolution rollback
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
      expect(localStorage.getItem("theme")).toBe("light");
    });
  });
});

describe("AccountThemeSelector (#659)", () => {
  it("renders all three theme options", () => {
    render(<AccountThemeSelector />);
    expect(screen.getByRole("button", { name: "System" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Light" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dark" })).toBeTruthy();
  });

  it("selects a theme on button click", async () => {
    const user = userEvent.setup({ delay: null });
    render(<AccountThemeSelector />);

    await user.click(screen.getByRole("button", { name: "Dark" }));

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(mockSetThemeAction).toHaveBeenCalledWith("dark");
  });
});
