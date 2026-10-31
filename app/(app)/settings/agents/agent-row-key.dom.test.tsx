// @vitest-environment jsdom
"use client";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRowKey } from "./agent-row-key";
import { agentBootstrapMessage } from "@/lib/agents/bootstrap-message";
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

describe("AgentRowKey", () => {
  it("copies that agent's setup and does not print the secret", async () => {
    vi.spyOn(clipboard, "copyText").mockResolvedValue(true);
    const apiKey = "ziki_secret_for_reviewer";
    render(<AgentRowKey apiKey={apiKey} prefix="ziki_secr" projectId="project-1" projectName="Web" />);

    expect(screen.getByText("ziki_secr…")).toBeDefined();
    expect(document.body.textContent).not.toContain(apiKey);
    fireEvent.click(screen.getByRole("button", { name: "Copy key" }));

    await waitFor(() => {
      expect(clipboard.copyText).toHaveBeenCalledWith(
        agentBootstrapMessage({ origin: window.location.origin, apiKey, projectName: "Web" }),
      );
    });
  });

  it("offers no copy for a key that was not sealed", () => {
    render(<AgentRowKey apiKey={null} prefix="ziki_old1" projectId="project-1" projectName="Web" />);
    expect(screen.queryByRole("button", { name: "Copy key" })).toBeNull();
  });
});
