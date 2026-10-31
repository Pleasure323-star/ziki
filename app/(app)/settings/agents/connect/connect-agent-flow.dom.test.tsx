// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAgentConnectedAction, startAgentConnectAction } from "./actions";
import { ConnectAgentFlow } from "./connect-agent-flow";

const refresh = vi.hoisted(() => vi.fn());
const copyText = vi.hoisted(() => vi.fn());

vi.mock("./actions", () => ({
  startAgentConnectAction: vi.fn(),
  checkAgentConnectedAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/clipboard", () => ({ copyText }));

const SETUP = "You are my Ziki agent for Alpha.\n\nAPI key: zk_secret";

beforeAll(() => {
  // jsdom has no modal dialogs; open it the way the browser would.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  copyText.mockResolvedValue(true);
  vi.mocked(startAgentConnectAction).mockResolvedValue({
    ok: true,
    agentId: "agent_1",
    name: "Claude",
    setupText: SETUP,
  });
  vi.mocked(checkAgentConnectedAction).mockResolvedValue({ connected: false });
});

async function reachCopyStep(user = userEvent.setup({ delay: null })) {
  render(<ConnectAgentFlow projectId="proj_1" />);
  await user.click(screen.getByRole("button", { name: "Connect agent" }));
  await user.type(screen.getByLabelText("Agent name"), "Claude");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("button", { name: "Copy" });
  return user;
}

describe("ConnectAgentFlow", () => {
  it("starts as a single Connect agent button", () => {
    render(<ConnectAgentFlow projectId="proj_1" />);
    expect(screen.getByRole("button", { name: "Connect agent" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is disabled without a project to work in", () => {
    render(<ConnectAgentFlow projectId={null} />);
    expect(screen.getByRole("button", { name: "Connect agent" }).hasAttribute("disabled")).toBe(true);
  });

  it("creates the named agent and copies its text without showing the key", async () => {
    const user = await reachCopyStep();
    expect(startAgentConnectAction).toHaveBeenCalledWith({ name: "Claude", projectId: "proj_1" });
    expect(screen.queryByText(/zk_secret/)).toBeNull();
    expect(screen.getByRole("button", { name: "I've pasted it" }).hasAttribute("disabled")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(copyText).toHaveBeenCalledWith(SETUP);
    // Copying is what unlocks the next step.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "I've pasted it" }).hasAttribute("disabled")).toBe(false),
    );
  });

  it("shows the registry's error and stays on the name step", async () => {
    vi.mocked(startAgentConnectAction).mockResolvedValue({ ok: false, error: "You already have 5 active agents." });
    const user = userEvent.setup({ delay: null });
    render(<ConnectAgentFlow projectId="proj_1" />);
    await user.click(screen.getByRole("button", { name: "Connect agent" }));
    await user.type(screen.getByLabelText("Agent name"), "Claude");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe("You already have 5 active agents.");
    expect(screen.getByLabelText("Agent name")).toBeTruthy();
  });

  it("waits for the agent, dances when it connects, then closes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = await reachCopyStep(userEvent.setup({ advanceTimers: vi.advanceTimersByTime }));
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await user.click(screen.getByRole("button", { name: "I've pasted it" }));
    expect(await screen.findByRole("heading", { name: /waiting/i })).toBeTruthy();

    vi.mocked(checkAgentConnectedAction).mockResolvedValue({ connected: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole("heading", { name: /connected/i })).toBeTruthy();
    expect(checkAgentConnectedAction).toHaveBeenCalledWith("agent_1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });
});
