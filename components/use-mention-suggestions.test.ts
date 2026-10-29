// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { createElement, type KeyboardEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMentionSuggestions } from "./use-mention-suggestions";
import { MarkdownEditor } from "./markdown-editor";

afterEach(cleanup);

function setup() {
  const onChange = vi.fn();
  const { result } = renderHook(() => useMentionSuggestions({
    users: [{ id: "ada", name: "Ada" }, { id: "alan", name: "Alan" }],
    value: "@a",
    onChange,
    textareaRef: { current: null },
  }));
  act(() => result.current.sync("@a", 2));
  return { result, onChange };
}

function keyEvent(key: string, nativeEvent = {}) {
  return { key, nativeEvent, preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLTextAreaElement>;
}

describe("mention composition keys (#757)", () => {
  it.each([{ isComposing: true }, { keyCode: 229 }])("skips editor shortcuts during composition (%j)", (composition) => {
    const onChange = vi.fn();
    const { getByRole } = render(createElement(MarkdownEditor, {
      value: "@a", onChange, users: [{ id: "ada", name: "Ada" }],
    }));
    const textarea = getByRole("textbox");
    fireEvent.keyDown(textarea, { key: " ", ctrlKey: true, ...composition });
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(["Enter", "Tab", "ArrowDown", "ArrowUp", "Escape"])("leaves composing %s untouched", (key) => {
    const { result, onChange } = setup();
    const event = keyEvent(key, { isComposing: true });
    act(() => expect(result.current.handleKeyDown(event)).toBe(false));
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(result.current.showSuggestions).toBe(true);
    expect(result.current.activeIndex).toBe(0);
  });

  it("also ignores the IME key code when isComposing is false", () => {
    const { result, onChange } = setup();
    const event = keyEvent("Enter", { isComposing: false, keyCode: 229 });
    act(() => expect(result.current.handleKeyDown(event)).toBe(false));
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(result.current.showSuggestions).toBe(true);
  });

  it("keeps ordinary navigation and selection after composition", () => {
    const { result, onChange } = setup();
    act(() => result.current.handleKeyDown(keyEvent("Enter", { isComposing: true })));
    act(() => result.current.handleKeyDown(keyEvent("ArrowDown")));
    expect(result.current.activeIndex).toBe(1);
    const event = keyEvent("Enter");
    act(() => expect(result.current.handleKeyDown(event)).toBe(true));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith("@[Alan](alan) ");
    expect(result.current.showSuggestions).toBe(false);
  });
});

describe("mention span movement and selection clamping (#484)", () => {
  const users = [
    { id: "ada", name: "Ada" },
    { id: "alan", name: "Alan" },
    { id: "bob", name: "Bob" },
  ];

  it.each(["Enter", "Tab"])("resets selection when moving between spans and inserts on %s", (key) => {
    const onChange = vi.fn();
    const value = "@a @bo";
    const { result } = renderHook(() =>
      useMentionSuggestions({
        users,
        value,
        onChange,
        textareaRef: { current: null },
      }),
    );

    // Place caret after @a (position 2)
    act(() => result.current.sync(value, 2));
    expect(result.current.suggestions.map((u) => u.name)).toEqual(["Ada", "Alan"]);
    expect(result.current.activeIndex).toBe(0);

    // Highlight Alan with ArrowDown
    act(() => {
      result.current.handleKeyDown(keyEvent("ArrowDown"));
    });
    expect(result.current.activeIndex).toBe(1);

    // Click/caret after @bo (position 6), non-resetting sync
    act(() => result.current.sync(value, 6, false));
    expect(result.current.suggestions.map((u) => u.name)).toEqual(["Bob"]);
    expect(result.current.activeIndex).toBe(0);

    // Press Enter or Tab: assert Bob inserts
    const event = keyEvent(key);
    act(() => expect(result.current.handleKeyDown(event)).toBe(true));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith("@a @[Bob](bob) ");
    expect(result.current.showSuggestions).toBe(false);
  });

  it("preserves highlight on keyup within the same mention span (#201)", () => {
    const onChange = vi.fn();
    const value = "@a";
    const { result } = renderHook(() =>
      useMentionSuggestions({
        users,
        value,
        onChange,
        textareaRef: { current: null },
      }),
    );

    act(() => result.current.sync(value, 2));
    act(() => {
      result.current.handleKeyDown(keyEvent("ArrowDown"));
    });
    expect(result.current.activeIndex).toBe(1);

    // Keyup within same span (resetIndex=false)
    act(() => result.current.sync(value, 2, false));
    expect(result.current.activeIndex).toBe(1);

    const event = keyEvent("Enter");
    act(() => expect(result.current.handleKeyDown(event)).toBe(true));
    expect(onChange).toHaveBeenCalledWith("@[Alan](alan) ");
  });

  it("clamps activeIndex when user list changes asynchronously while open", () => {
    const onChange = vi.fn();
    const initialUsers = [
      { id: "ada", name: "Ada" },
      { id: "alan", name: "Alan" },
      { id: "alice", name: "Alice" },
    ];
    let currentUsers = initialUsers;
    const { result, rerender } = renderHook(
      ({ u }) =>
        useMentionSuggestions({
          users: u,
          value: "@a",
          onChange,
          textareaRef: { current: null },
        }),
      { initialProps: { u: currentUsers } },
    );

    act(() => result.current.sync("@a", 2));
    expect(result.current.suggestions).toHaveLength(3);

    // Move to index 2 (Alice)
    act(() => {
      result.current.handleKeyDown(keyEvent("ArrowDown"));
      result.current.handleKeyDown(keyEvent("ArrowDown"));
    });
    expect(result.current.activeIndex).toBe(2);

    // Alice is removed from users list
    currentUsers = [
      { id: "ada", name: "Ada" },
      { id: "alan", name: "Alan" },
    ];
    rerender({ u: currentUsers });

    expect(result.current.suggestions).toHaveLength(2);
    expect(result.current.activeIndex).toBe(1);

    const event = keyEvent("Enter");
    act(() => expect(result.current.handleKeyDown(event)).toBe(true));
    expect(onChange).toHaveBeenCalledWith("@[Alan](alan) ");
  });

  it.each(["Enter", "Tab"])("does not consume %s when there are no matches", (key) => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useMentionSuggestions({
        users,
        value: "@xyz",
        onChange,
        textareaRef: { current: null },
      }),
    );

    act(() => result.current.sync("@xyz", 4));
    expect(result.current.suggestions).toHaveLength(0);
    expect(result.current.showSuggestions).toBe(false);

    const event = keyEvent(key);
    act(() => expect(result.current.handleKeyDown(event)).toBe(false));
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("resets activeIndex on close and reopen", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useMentionSuggestions({
        users,
        value: "@a",
        onChange,
        textareaRef: { current: null },
      }),
    );

    act(() => result.current.sync("@a", 2));
    act(() => {
      result.current.handleKeyDown(keyEvent("ArrowDown"));
    });
    expect(result.current.activeIndex).toBe(1);

    // Close via Escape
    const escEvent = keyEvent("Escape");
    act(() => expect(result.current.handleKeyDown(escEvent)).toBe(true));
    expect(result.current.showSuggestions).toBe(false);
    expect(result.current.activeIndex).toBe(0);

    // Reopen
    act(() => result.current.sync("@a", 2));
    expect(result.current.showSuggestions).toBe(true);
    expect(result.current.activeIndex).toBe(0);
  });

  it("handles caret movement between spans in MarkdownEditor component", () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      createElement(MarkdownEditor, {
        value: "@a @bo",
        onChange,
        users,
      }),
    );
    const textarea = getByRole("textbox") as HTMLTextAreaElement;

    // Place caret at @a (caret: 2)
    textarea.selectionStart = 2;
    textarea.selectionEnd = 2;
    fireEvent.click(textarea);

    // Press ArrowDown to highlight Alan
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyUp(textarea, { key: "ArrowDown" });

    // Click after @bo (caret: 6)
    textarea.selectionStart = 6;
    textarea.selectionEnd = 6;
    fireEvent.click(textarea);

    // Press Enter to insert Bob
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("@a @[Bob](bob) ");
  });
});
