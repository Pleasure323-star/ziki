// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManageAgentsList, type ManageAgentItem } from "./manage-agents-list";

vi.mock("./agent-controls", () => ({
  AgentControls: ({ agentName }: { agentName: string }) => <button type="button">Revoke {agentName}</button>,
}));
vi.mock("./agent-row-key", () => ({ AgentRowKey: () => <button type="button">Copy key</button> }));

afterEach(() => cleanup());

function agent(overrides: Partial<ManageAgentItem>): ManageAgentItem {
  return {
    id: "agent_1",
    name: "Pixel",
    model: "Claude",
    level: "working",
    burst: false,
    burstUntil: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    revokedAt: null,
    personal: false,
    avatar: null,
    currentProjectId: "proj_1",
    recent: true,
    apiKeys: [{ id: "key_1", prefix: "zk_ab", apiKey: "zk_secret", projectId: "proj_1", projectName: "Alpha", lastUsedAt: null }],
    ...overrides,
  };
}

function renderList(agents: ManageAgentItem[]) {
  render(
    <ManageAgentsList
      agents={agents}
      activeCount={agents.length}
      maxActive={5}
      levels={["working"]}
      projects={[{ id: "proj_1", name: "Alpha" }]}
      now="2026-10-28T10:00:00.000Z"
      canSetBurst={false}
    />,
  );
}

describe("ManageAgentsList cards", () => {
  it("lists a card per agent, each with its own avatar", () => {
    renderList([agent({}), agent({ id: "agent_2", name: "Scout Two" })]);
    const list = screen.getByRole("list");
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    for (const card of cards) expect(within(card).getByTestId("agent-avatar")).toBeTruthy();
  });

  it("links the card to the agent's own page and keeps its controls", () => {
    renderList([agent({ id: "agent_2", name: "Scout Two" })]);
    const card = screen.getByRole("listitem");
    const link = within(card).getByRole("link", { name: "Scout Two" });
    expect(link.getAttribute("href")).toBe("/settings/agent/Scout%20Two");
    expect(within(card).getByRole("button", { name: "Copy key" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Revoke Scout Two" })).toBeTruthy();
  });
});
