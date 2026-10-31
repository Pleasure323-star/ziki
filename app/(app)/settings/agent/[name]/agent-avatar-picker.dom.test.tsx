// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setAgentAvatarAction } from "./actions";
import { AgentAvatarPicker } from "./agent-avatar-picker";

const refresh = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());

vi.mock("./actions", () => ({ setAgentAvatarAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => toast }));

beforeAll(() => {
  // jsdom has no modal dialogs; open it the way the browser would.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
});
afterEach(() => cleanup());
beforeEach(() => vi.clearAllMocks());

async function openPicker(avatar: string | null) {
  render(<AgentAvatarPicker agentId="agent_1" agentName="Pixel" avatar={avatar} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Change Pixel's avatar" }));
  return user;
}

describe("AgentAvatarPicker", () => {
  it("shows only the avatar until it is clicked", () => {
    render(<AgentAvatarPicker agentId="agent_1" agentName="Pixel" avatar={null} />);
    expect(screen.getByRole("button", { name: "Change Pixel's avatar" }).getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("opens a pop-up of Automatic and every robot, with the current pick checked", async () => {
    await openPicker("mint");
    expect(screen.getByRole("dialog")).toBeTruthy();
    const options = screen.getAllByRole("radio");
    expect(options).toHaveLength(13);
    expect(screen.getByRole("radio", { name: /automatic/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Mint" }).getAttribute("aria-checked")).toBe("true");
  });

  it("saves a pick at once and closes the pop-up", async () => {
    vi.mocked(setAgentAvatarAction).mockResolvedValue({ ok: true });
    const user = await openPicker(null);
    await user.click(screen.getByRole("radio", { name: "Grape" }));
    expect(setAgentAvatarAction).toHaveBeenCalledWith("agent_1", "grape");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it("closes without saving on Cancel", async () => {
    const user = await openPicker("sky");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setAgentAvatarAction).not.toHaveBeenCalled();
  });

  it("goes back to the previous pick when saving is refused", async () => {
    vi.mocked(setAgentAvatarAction).mockResolvedValue({ ok: false, error: "That agent is revoked." });
    const user = await openPicker("sky");
    await user.click(screen.getByRole("radio", { name: "Automatic" }));
    expect(setAgentAvatarAction).toHaveBeenCalledWith("agent_1", null);
    expect(toast).toHaveBeenCalledWith("That agent is revoked.", "error");
    await user.click(screen.getByRole("button", { name: "Change Pixel's avatar" }));
    expect(screen.getByRole("radio", { name: "Sky" }).getAttribute("aria-checked")).toBe("true");
  });
});
