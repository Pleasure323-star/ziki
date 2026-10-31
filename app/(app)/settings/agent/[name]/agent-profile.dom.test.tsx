// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentActivity, AgentProfileCard, type AgentProfileData } from "./agent-profile";

afterEach(() => cleanup());

const agent: AgentProfileData = {
  id: "agent_1",
  name: "Pixel",
  model: "Claude",
  avatar: null,
  level: "working",
  revokedAt: null,
  createdAt: new Date("2026-10-01T10:00:00Z"),
  ownerName: null,
  lastActiveAt: null,
  projects: ["Alpha"],
  counts: { filed: 4, claims: 2, comments: 9 },
};

describe("AgentProfileCard", () => {
  it("shows who the agent is and what it has done", () => {
    render(<AgentProfileCard agent={agent} title={<h1>Pixel</h1>} />);
    expect(screen.getByRole("heading", { name: "Pixel" })).toBeTruthy();
    expect(screen.getByTestId("agent-avatar")).toBeTruthy();
    expect(screen.getByText("Working agent")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("Never")).toBeTruthy();
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(within(screen.getByText("Issues filed").parentElement!).getByText("4")).toBeTruthy();
    expect(within(screen.getByText("Claims").parentElement!).getByText("2")).toBeTruthy();
    expect(within(screen.getByText("Comments").parentElement!).getByText("9")).toBeTruthy();
  });

  it("names another owner and marks a revoked agent", () => {
    render(
      <AgentProfileCard
        agent={{ ...agent, ownerName: "Ada", revokedAt: new Date("2026-10-02T10:00:00Z") }}
        title={<h1>Pixel</h1>}
      />,
    );
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("Revoked")).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
  });
});

describe("AgentActivity", () => {
  it("lists actions in plain words, linked to their issue", () => {
    render(
      <AgentActivity
        items={[
          {
            id: "e1",
            createdAt: new Date("2026-10-03T10:00:00Z"),
            action: "issue.created",
            target: null,
            bug: { id: "bug_1", number: 12, title: "Login button overlaps", project: { slug: "ziki" } },
            undone: false,
          },
          {
            id: "e2",
            createdAt: new Date("2026-10-02T10:00:00Z"),
            action: "agent.key_rotated",
            target: "agent:agent_1",
            bug: null,
            undone: true,
          },
        ]}
      />,
    );
    expect(screen.queryByText(/issue\.created|agent\.key_rotated/)).toBeNull();
    expect(screen.getByRole("link", { name: /#12 Login button overlaps/ }).getAttribute("href")).toBe("/ziki/12");
    expect(screen.getByText(/undone/i)).toBeTruthy();
  });
});
