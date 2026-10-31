// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownEditor } from "./markdown-editor";

afterEach(() => {
  cleanup();
});

describe("MarkdownEditor responsive toolbar on 360px phones (#696)", () => {
  it("supports keyboard Tab navigation through all toolbar tools", async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <MarkdownEditor
        value="Hello world"
        onChange={() => {}}
        aria-label="Description"
      />,
    );

    const writeTab = screen.getByRole("button", { name: "Write" });
    writeTab.focus();
    expect(writeTab).toHaveFocus();

    // Tab to the Preview button
    await user.tab();
    const previewTab = screen.getByRole("button", { name: /Preview/i });
    expect(previewTab).toHaveFocus();

    // Tab into the toolbar: first tool is Bold
    await user.tab();
    const boldBtn = screen.getByRole("button", { name: "Bold" });
    expect(boldBtn).toHaveFocus();

    // Tab to next tool: Italic
    await user.tab();
    const italicBtn = screen.getByRole("button", { name: "Italic" });
    expect(italicBtn).toHaveFocus();

    // Tab to next tool: Strikethrough
    await user.tab();
    const strikeBtn = screen.getByRole("button", { name: "Strikethrough" });
    expect(strikeBtn).toHaveFocus();
  });

  it("updates fade cues dynamically when scrolling horizontally", () => {
    render(
      <MarkdownEditor
        value="Hello world"
        onChange={() => {}}
        aria-label="Description"
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "Formatting" });

    // Mock dimensions where total scrollWidth exceeds visible clientWidth (mobile overflow)
    Object.defineProperty(toolbar, "scrollWidth", { value: 600, configurable: true });
    Object.defineProperty(toolbar, "clientWidth", { value: 250, configurable: true });
    Object.defineProperty(toolbar, "scrollLeft", { value: 0, writable: true, configurable: true });

    // Fire scroll at position 0: should show right fade cue, no left cue
    act(() => {
      fireEvent.scroll(toolbar);
    });

    const rightCue = screen.getByTestId("fade-cue-right");
    expect(rightCue).toBeInTheDocument();
    expect(rightCue).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByTestId("fade-cue-left")).toBeNull();

    // Scroll to the middle (scrollLeft = 100): both left and right cues should be visible
    toolbar.scrollLeft = 100;
    act(() => {
      fireEvent.scroll(toolbar);
    });

    expect(screen.getByTestId("fade-cue-left")).toBeInTheDocument();
    expect(screen.getByTestId("fade-cue-right")).toBeInTheDocument();

    // Scroll all the way to the end (scrollLeft = 350 = 600 - 250): right cue disappears, left cue remains
    toolbar.scrollLeft = 350;
    act(() => {
      fireEvent.scroll(toolbar);
    });

    expect(screen.getByTestId("fade-cue-left")).toBeInTheDocument();
    expect(screen.queryByTestId("fade-cue-right")).toBeNull();
  });

  it("applies formatting correctly when toolbar buttons are clicked", async () => {
    let text = "Selected text";
    const user = userEvent.setup({ delay: null });
    const { container } = render(
      <MarkdownEditor
        value={text}
        onChange={(next) => {
          text = next;
        }}
        aria-label="Description"
      />,
    );

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(0, 13); // select "Selected text"

    const boldBtn = screen.getByRole("button", { name: "Bold" });
    await user.click(boldBtn);

    expect(text).toBe("**Selected text**");
  });
});
