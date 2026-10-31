// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { ZikiHomepage } from "./ziki-homepage";

describe("ZikiHomepage (#487)", () => {
  beforeEach(() => cleanup());

  it("renders guest CTAs when user is not signed in", () => {
    render(<ZikiHomepage />);

    const signinLinks = screen.getAllByRole("link", { name: /sign in/i });
    expect(signinLinks.length).toBeGreaterThan(0);
    expect(signinLinks[0]).toHaveAttribute("href", "/login");

    const getStartedLinks = screen.getAllByRole("link", { name: /get started/i });
    expect(getStartedLinks.length).toBeGreaterThan(0);
    expect(getStartedLinks[0]).toHaveAttribute("href", "/login");
  });

  it("renders workspace entry CTAs when user is signed in", () => {
    render(<ZikiHomepage user={{ name: "Mbakara Goodness", email: "goodness@example.com" }} />);

    const workspaceLinks = screen.getAllByRole("link", { name: /workspace/i });
    expect(workspaceLinks.length).toBeGreaterThan(0);
    expect(workspaceLinks[0]).toHaveAttribute("href", "/issues");
  });

  it("provides links to /llms.txt for autonomous agent documentation", () => {
    render(<ZikiHomepage />);

    const llmsLinks = screen.getAllByRole("link", { name: /\/llms\.txt/i });
    expect(llmsLinks.length).toBeGreaterThan(0);
    expect(llmsLinks[0]).toHaveAttribute("href", "/llms.txt");
  });

  it("toggles the mobile navigation menu when the hamburger button is clicked", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<ZikiHomepage />);

    const toggleButton = screen.getByRole("button", { name: /toggle navigation menu/i });
    expect(toggleButton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("navigation", { name: "Mobile navigation" })).not.toBeInTheDocument();

    await user.click(toggleButton);
    expect(toggleButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("navigation", { name: "Mobile navigation" })).toBeInTheDocument();

    await user.click(toggleButton);
    expect(toggleButton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("navigation", { name: "Mobile navigation" })).not.toBeInTheDocument();
  });
});
