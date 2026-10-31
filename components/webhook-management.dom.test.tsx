// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
  reEnable: vi.fn(),
}));
vi.mock("@/app/actions/webhooks", () => ({
  createWebhookAction: actions.create,
  deleteWebhookAction: actions.remove,
  listWebhooksAction: actions.list,
  reEnableWebhookAction: actions.reEnable,
}));
vi.mock("@/components/ui/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));

import { WebhookManagement } from "./webhook-management";

const agent = { id: "agent-1", name: "Power Ranger" };

beforeEach(() => {
  vi.clearAllMocks();
  actions.list.mockResolvedValue({ ok: true, subscriptions: [], agents: [agent] });
});
afterEach(() => cleanup());

describe("WebhookManagement", () => {
  it("shows a retryable error when the initial list action rejects", async () => {
    const user = userEvent.setup({ delay: null });
    actions.list
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({ ok: true, subscriptions: [], agents: [] });
    render(<WebhookManagement />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Add webhook" })).toBeInTheDocument();
    expect(actions.list).toHaveBeenCalledTimes(2);
  });

  it("keeps Add webhook disabled until an agent is picked and the URL is valid https://", async () => {
    const user = userEvent.setup({ delay: null });
    render(<WebhookManagement />);

    const add = await screen.findByRole("button", { name: "Add webhook" });
    expect(add).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: /Power Ranger/i }));
    expect(add).toBeDisabled();

    const url = screen.getByLabelText(/HTTPS endpoint URL/i);
    await user.type(url, "http://insecure.example/hooks");
    expect(add).toBeDisabled();

    await user.clear(url);
    await user.type(url, "https://incomplete");
    expect(add).toBeDisabled();

    await user.clear(url);
    await user.type(url, "https://example.com/hooks/ziki");
    expect(add).toBeEnabled();
  });

  it("reveals the signing secret once after a successful create", async () => {
    const user = userEvent.setup({ delay: null });
    actions.create.mockResolvedValue({
      ok: true,
      secret: "whsec_test_secret_once",
      subscription: {
        id: "sub-1",
        url: "https://example.com/hooks/ziki",
        enabled: true,
        failureCount: 0,
        disabledAt: null,
        createdAt: new Date(),
        lastError: null,
        lastErrorAt: null,
        lastDeliveredAt: null,
        agent,
      },
    });
    actions.list
      .mockResolvedValueOnce({ ok: true, subscriptions: [], agents: [agent] })
      .mockResolvedValueOnce({
        ok: true,
        subscriptions: [
          {
            id: "sub-1",
            url: "https://example.com/hooks/ziki",
            enabled: true,
            failureCount: 0,
            disabledAt: null,
            createdAt: new Date(),
            lastError: null,
            lastErrorAt: null,
            lastDeliveredAt: null,
            agent,
          },
        ],
        agents: [agent],
      });

    render(<WebhookManagement />);

    await user.click(await screen.findByRole("radio", { name: /Power Ranger/i }));
    await user.type(
      screen.getByLabelText(/HTTPS endpoint URL/i),
      "https://example.com/hooks/ziki",
    );
    await user.click(screen.getByRole("button", { name: "Add webhook" }));

    const reveal = await screen.findByRole("status");
    expect(within(reveal).getByText("whsec_test_secret_once")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("1 active")).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "https://example.com/hooks/ziki" }),
      ).toBeInTheDocument();
    });
  });

  it("lists subscriptions with Active status and delete control", async () => {
    actions.list.mockResolvedValue({
      ok: true,
      agents: [agent],
      subscriptions: [
        {
          id: "sub-1",
          url: "https://hooks.example/ziki",
          enabled: true,
          failureCount: 0,
          disabledAt: null,
          createdAt: new Date("2024-01-01T00:00:00Z"),
          lastError: null,
          lastErrorAt: null,
          lastDeliveredAt: null,
          agent,
        },
      ],
    });

    render(<WebhookManagement />);

    expect(await screen.findByText("1 active")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://hooks.example/ziki" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Delete webhook for Power Ranger/i }),
    ).toBeInTheDocument();
  });
});
