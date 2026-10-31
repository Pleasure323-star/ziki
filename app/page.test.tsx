// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import Homepage from "@/components/homepage/homepage";

const applyTheme = vi.hoisted(() => vi.fn());
const useTheme = vi.hoisted(() => vi.fn(() => ["light", vi.fn(), false] as const));
vi.mock("@/components/theme-toggle", () => ({ useTheme, applyThemeClient: applyTheme }));
vi.mock("next/image", () => ({ default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => React.createElement("img", props) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href, ...props }, children),
}));

beforeEach(() => {
  useTheme.mockReturnValue(["light", vi.fn(), false]);
  vi.stubGlobal("React", React);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("Public homepage", () => {
  it("keeps conversion links on the existing sign-in route", () => {
    render(<Homepage />);
    for (const label of ["Get started free", "Get started with Ziki", "Start contributing"]) {
      expect(screen.getByRole("link", { name: new RegExp(label) }).getAttribute("href")).toBe("/login");
    }
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main-content");
  });
  it("opens the mobile menu and closes it on Escape or section selection", () => {
    render(<Homepage />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(screen.getByRole("button", { name: "Close menu" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Open menu" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getAllByRole("link", { name: "AI agents" })[0]);
    expect(screen.getByRole("button", { name: "Open menu" })).toBeTruthy();
  });
  it("uses the existing browser preference without a sign-in action", () => {
    render(<Homepage />);
    fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }));
    expect(applyTheme).toHaveBeenCalledWith("dark");
  });
  it("uses Get started as the single authentication entry point in each header layout", () => {
    render(<Homepage />);
    const navigation = screen.getByRole("navigation", { name: "Main navigation" });
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(within(navigation).getByRole("link", { name: "Get started" }).getAttribute("href")).toBe("/login");
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(within(navigation).getByRole("link", { name: "Get started" }));
    expect(screen.getByRole("button", { name: "Open menu" }).getAttribute("aria-expanded")).toBe("false");
  });
  it("saves a signed-in theme through the account preference", () => {
    const setTheme = vi.fn();
    useTheme.mockReturnValue(["light", setTheme, false]);
    render(<Homepage signedIn />);
    fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }));
    expect(setTheme).toHaveBeenCalledWith("dark");
    expect(applyTheme).not.toHaveBeenCalled();
  });
});
