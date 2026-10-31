// @vitest-environment jsdom
"use client";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentPicker } from "./attachment-picker";

describe("AttachmentPicker (#734)", () => {
  let user: ReturnType<typeof userEvent.setup>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    user = userEvent.setup({ delay: null });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    cleanup();
  });

  it("notifies parent of uploading state while uploads are in flight", async () => {
    let resolveUpload: (val: unknown) => void = () => {};
    global.fetch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = () =>
            resolve({
              ok: true,
              json: async () => ({ id: "att-123", size: 1024 }),
            });
        }),
    );

    const onUploadingChange = vi.fn();
    const onChange = vi.fn();

    const { container } = render(
      <AttachmentPicker
        onChange={onChange}
        onUploadingChange={onUploadingChange}
      />,
    );

    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    const testFile = new File(["dummy content"], "test.png", {
      type: "image/png",
    });

    await user.upload(fileInput, testFile);

    await waitFor(() => {
      expect(onUploadingChange).toHaveBeenCalledWith(true);
      expect(screen.getByText(/uploading/i)).toBeTruthy();
    });

    // While uploading, onChange should not have received the attachment ID yet
    expect(onChange).not.toHaveBeenCalledWith(expect.arrayContaining(["att-123"]));

    // Resolve upload
    resolveUpload(null);

    await waitFor(() => {
      expect(onUploadingChange).toHaveBeenLastCalledWith(false);
      expect(onChange).toHaveBeenCalledWith(["att-123"]);
      expect(screen.queryByText(/uploading/i)).toBeNull();
    });
  });

  it("notifies parent when upload fails with an error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "File too large" }),
    });

    const onUploadingChange = vi.fn();
    const onChange = vi.fn();

    const { container } = render(
      <AttachmentPicker
        onChange={onChange}
        onUploadingChange={onUploadingChange}
      />,
    );

    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    const testFile = new File(["dummy content"], "huge.png", {
      type: "image/png",
    });

    await user.upload(fileInput, testFile);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("File too large");
      expect(onUploadingChange).toHaveBeenLastCalledWith(false);
      expect(onChange).not.toHaveBeenCalledWith(expect.arrayContaining(["huge.png"]));
    });
  });

  it("rejects files over 5 MB before making an upload request", async () => {
    global.fetch = vi.fn();
    const { container } = render(<AttachmentPicker />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const oversized = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" });

    await user.upload(fileInput, oversized);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
