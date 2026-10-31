// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAgentLevelAction } from "@/app/(app)/settings/agents/actions";
import { renameAgentAction } from "./actions";
import { AgentSettingsForm } from "./agent-settings-form";

const replace = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());

vi.mock("./actions", () => ({ renameAgentAction: vi.fn() }));
vi.mock("@/app/(app)/settings/agents/actions", () => ({ setAgentLevelAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => toast }));

afterEach(() => cleanup());
beforeEach(() => vi.clearAllMocks());

function renderForm() {
  render(
    <AgentSettingsForm agentId="agent_1" name="Pixel" level="manager" levels={["working"]} />,
  );
  return userEvent.setup({ delay: null });
}

describe("AgentSettingsForm", () => {
  it("renames the agent and moves to its new address", async () => {
    vi.mocked(renameAgentAction).mockResolvedValue({ ok: true, name: "Pixel Two" });
    const user = renderForm();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Pixel Two");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(renameAgentAction).toHaveBeenCalledWith("agent_1", "Pixel Two");
    expect(replace).toHaveBeenCalledWith("/settings/agent/Pixel%20Two");
  });

  it("shows why a rename was refused and stays put", async () => {
    vi.mocked(renameAgentAction).mockResolvedValue({ ok: false, error: "There's already an agent called “Scout”." });
    const user = renderForm();
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Scout");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("already an agent");
    expect(replace).not.toHaveBeenCalled();
  });

  it("changes the level, offering only the levels this viewer may set", async () => {
    vi.mocked(setAgentLevelAction).mockResolvedValue({ ok: true });
    const user = renderForm();
    const select = screen.getByLabelText("Level") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["manager", "working"]);
    expect(select.options[0].disabled).toBe(true);
    await user.selectOptions(select, "working");
    expect(setAgentLevelAction).toHaveBeenCalledWith("agent_1", "working");
    expect(refresh).toHaveBeenCalled();
  });

  it("puts the level back when the change is refused", async () => {
    vi.mocked(setAgentLevelAction).mockResolvedValue({ ok: false, error: "That agent is revoked." });
    const user = renderForm();
    await user.selectOptions(screen.getByLabelText("Level"), "working");
    expect((screen.getByLabelText("Level") as HTMLSelectElement).value).toBe("manager");
    expect(toast).toHaveBeenCalledWith("That agent is revoked.", "error");
  });
});
