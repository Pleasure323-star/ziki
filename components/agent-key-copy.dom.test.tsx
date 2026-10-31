// @vitest-environment jsdom
"use client";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentKeyCopyButton } from "./agent-key-copy";
import { agentAccessRequest, agentBootstrapMessage } from "@/lib/agents/bootstrap-message";
import * as clipboard from "@/lib/clipboard";

const mockToast = vi.fn();
vi.mock("@/components/ui/toast", () => ({
  useToast: () => mockToast,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  mockToast.mockReset();
});

describe("AgentKeyCopyButton", () => {
  it("renders null when projectId is missing", () => {
    const { container } = render(<AgentKeyCopyButton projectId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the copy button", () => {
    render(<AgentKeyCopyButton projectId="cly-test-project-123" projectName="Zedu Core" />);
    expect(screen.getByRole("button", { name: "Copy key to agent" })).toBeDefined();
  });

  it("copies project key to clipboard when copy button is clicked", async () => {
    vi.spyOn(clipboard, "copyText").mockResolvedValue(true);

    render(<AgentKeyCopyButton projectId="cly-test-project-123" projectName="Zedu Core" />);
    const copyButton = screen.getByRole("button", { name: "Copy key to agent" });
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(clipboard.copyText).toHaveBeenCalledWith("cly-test-project-123");
      expect(mockToast).toHaveBeenCalled();
    });
  });

  it("opens details popover on clicking key label and displays project key info", () => {
    render(<AgentKeyCopyButton projectId="cly-test-project-123" projectName="Zedu Core" />);
    const detailsButton = screen.getByRole("button", { name: /Agent Key:/ });
    fireEvent.click(detailsButton);

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText("Zedu Core")).toBeDefined();
    expect(screen.getByText("cly-test-project-123")).toBeDefined();
  });

  it("lists live key prefixes and never a full secret", () => {
    render(
      <AgentKeyCopyButton
        projectId="cly-test-project-123"
        projectName="Zedu Core"
        keys={[{ prefix: "ziki_Ab3dE6", projectName: "Zedu Core" }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Agent Key:/ }));
    expect(screen.getByText(/ziki_Ab3dE6/)).toBeDefined();
    expect(screen.queryByText(/ziki_Ab3dE6[A-Za-z0-9_-]/)).toBeNull();
  });

  it("copies the site and the personal key so an agent can start", async () => {
    vi.spyOn(clipboard, "copyText").mockResolvedValue(true);
    const apiKey = "ziki_secret_full_value_not_shown";
    render(
      <AgentKeyCopyButton
        projectId="cly-test-project-123"
        projectName="Zedu Core"
        apiKey={apiKey}
        keyPrefix="ziki_secr"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy key to agent" }));

    await waitFor(() => {
      expect(clipboard.copyText).toHaveBeenCalledWith(
        agentBootstrapMessage({ origin: window.location.origin, apiKey, projectName: "Zedu Core" }),
      );
      expect(mockToast).toHaveBeenCalled();
    });
    expect(document.body.textContent).not.toContain(apiKey);
    expect(screen.getByText("ziki_secr")).toBeDefined();
  });

  it("copies only the site so the agent can request access", async () => {
    vi.spyOn(clipboard, "copyText").mockResolvedValue(true);
    render(
      <AgentKeyCopyButton
        projectId="cly-test-project-123"
        projectName="Zedu Core"
        apiKey="ziki_secret_full_value_not_shown"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Agent Key:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Copy site" }));

    await waitFor(() => {
      expect(clipboard.copyText).toHaveBeenCalledWith(
        agentAccessRequest({ origin: window.location.origin, projectName: "Zedu Core" }),
      );
      expect(mockToast).toHaveBeenCalled();
    });
  });

  it("copies the project id from the details, not the personal key", async () => {
    vi.spyOn(clipboard, "copyText").mockResolvedValue(true);
    render(
      <AgentKeyCopyButton
        projectId="cly-test-project-123"
        projectName="Zedu Core"
        apiKey="ziki_secret_full_value_not_shown"
        keyPrefix="ziki_secr"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Agent Key:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Copy id" }));

    await waitFor(() => {
      expect(clipboard.copyText).toHaveBeenCalledWith("cly-test-project-123");
      expect(mockToast).toHaveBeenCalled();
    });
  });

  it("handles copy failure gracefully", async () => {
    vi.spyOn(clipboard, "copyText").mockResolvedValue(false);

    render(<AgentKeyCopyButton projectId="cly-fail-id" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy key to agent" }));

    await waitFor(() => {
      expect(clipboard.copyText).toHaveBeenCalledWith("cly-fail-id");
      expect(mockToast).toHaveBeenCalledWith(expect.stringContaining("cly-fail-id"), "error");
    });
  });
});
