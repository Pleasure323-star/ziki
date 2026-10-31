// @vitest-environment jsdom
"use client";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyProjectIdButton } from "./copy-project-id";
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

describe("CopyProjectIdButton (#629)", () => {
  it("copies project ID and confirms it on click", async () => {
    vi.spyOn(clipboard, "copyText").mockResolvedValue(true);

    render(<CopyProjectIdButton projectId="proj-123" />);
    fireEvent.click(screen.getByRole("button", { name: /copy project id/i }));

    await waitFor(() => {
      expect(clipboard.copyText).toHaveBeenCalledWith("proj-123");
      expect(mockToast).toHaveBeenCalled();
      expect(mockToast).not.toHaveBeenCalledWith(expect.anything(), "error");
    });
  });

  it("shows the ID in an error toast when copying fails, so it can be copied by hand", async () => {
    vi.spyOn(clipboard, "copyText").mockResolvedValue(false);

    render(<CopyProjectIdButton projectId="proj-123" />);
    fireEvent.click(screen.getByRole("button", { name: /copy project id/i }));

    await waitFor(() => {
      expect(clipboard.copyText).toHaveBeenCalledWith("proj-123");
      expect(mockToast).toHaveBeenCalledWith(expect.stringContaining("proj-123"), "error");
    });
  });
});
