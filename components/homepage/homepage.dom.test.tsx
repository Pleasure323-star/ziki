// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { ZikiHomepage } from "./ziki-homepage";

describe("ZikiHomepage (#487)", () => {
  beforeEach(() => cleanup());

  it("renders all 8 required sections with proper headings and semantic landmarks", () => {
    render(<ZikiHomepage />);

    // 1. Navigation
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();

    // 2. Hero
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      /resolve issues faster with autonomous ai agents/i,
    );

    // 3. AI-Powered Issue Resolution
    expect(screen.getByRole("heading", { level: 2, name: /ai-powered issue resolution/i })).toBeInTheDocument();

    // 4. Multi-Agent Collaboration
    expect(screen.getByRole("heading", { level: 2, name: /multi-agent collaboration tiers/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Observer" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Contributor" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Reviewer" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Merger" })).toBeInTheDocument();

    // Agent Quickstart & Guide
    expect(
      screen.getByRole("heading", { level: 2, name: /autonomous agents quickstart & api guide/i }),
    ).toBeInTheDocument();

    // 5. How Ziki Works
    expect(screen.getByRole("heading", { level: 2, name: /how ziki works/i })).toBeInTheDocument();
    expect(screen.getByText("Discover & Ingest")).toBeInTheDocument();
    expect(screen.getByText("Bid & Investigate")).toBeInTheDocument();
    expect(screen.getByText("Independent Review")).toBeInTheDocument();
    expect(screen.getByText("Merge & Reward")).toBeInTheDocument();

    // 6. Contribution Rewards
    expect(screen.getByRole("heading", { level: 2, name: /transparent contribution rewards/i })).toBeInTheDocument();
    expect(screen.getAllByText("+150 pts")).toHaveLength(1);
    expect(screen.getByText("90, then less")).toBeInTheDocument();
    expect(screen.getByText("300, then less")).toBeInTheDocument();
    expect(screen.getByText("+750 pts")).toBeInTheDocument();
    expect(screen.queryByText(/1200|1800/)).not.toBeInTheDocument();
    expect(screen.getByText("500 pts")).toBeInTheDocument();

    // 7. Team & Organization Workflows
    expect(screen.getByRole("heading", { level: 2, name: /built for teams & organizations/i })).toBeInTheDocument();
    expect(screen.getByText("Individual Builders")).toBeInTheDocument();
    expect(screen.getByText("Engineering Teams")).toBeInTheDocument();
    expect(screen.getByText("Enterprises & Orgs")).toBeInTheDocument();

    // 8. Final Call to Action & Footer
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: /ready to resolve issues with ai speed and human precision/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

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
