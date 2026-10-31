import { describe, expect, it } from "vitest";
import {
  IDLE,
  isTypingTarget,
  SEQUENCE_TIMEOUT_MS,
  shortcutFor,
  shortcutGroups,
  stepRow,
} from "./keyboard-shortcuts";

const body = { tagName: "BODY", closest: () => null };
const press = (
  key: string,
  extra: object = {},
  target: object | null = body,
  state = IDLE,
  now = 1000,
  options: { dashboard?: boolean } = {},
) => shortcutFor({ key, ...extra }, target as never, state, now, options);

describe("shortcutFor (#287)", () => {
  it("maps the single keys", () => {
    expect(press("/").action).toBe("focus-search");
    expect(press("j").action).toBe("next-row");
    expect(press("k").action).toBe("previous-row");
    expect(press("n").action).toBe("new-issue");
    expect(press("c").action).toBe("new-issue");
    expect(press("?").action).toBe("show-help");
    expect(press("x").action).toBeNull();
  });

  it("maps Ctrl+K and Cmd+K to search", () => {
    expect(press("k", { ctrlKey: true }).action).toBe("focus-search");
    expect(press("K", { ctrlKey: true }).action).toBe("focus-search");
    expect(press("k", { metaKey: true }).action).toBe("focus-search");
    expect(press("k", { ctrlKey: true, altKey: true }).action).toBeNull();
    // Non-Latin layout: the produced character differs but the key is the
    // same physically.
    expect(press("л", { ctrlKey: true, code: "KeyK" }).action).toBe("focus-search");
  });

  it("handles g then i / d / n, within the timeout only", () => {
    const g = press("g");
    expect(g.action).toBeNull();
    expect(press("i", {}, body, g.state, 1500).action).toBe("go-issues");
    expect(press("d", {}, body, g.state, 1500).action).toBe("go-dashboard");
    expect(press("n", {}, body, g.state, 1500).action).toBe("go-notifications");
    expect(press("i", {}, body, g.state, 1000 + SEQUENCE_TIMEOUT_MS + 1).action).toBeNull();
  });

  it("hides the admin dashboard shortcut when asked", () => {
    const g = press("g");
    expect(press("d", {}, body, g.state, 1500, { dashboard: false }).action).toBeNull();
  });

  it("never fires while typing", () => {
    for (const t of [
      { tagName: "INPUT", type: "text" },
      { tagName: "INPUT", type: "search" },
      { tagName: "TEXTAREA" },
      { tagName: "SELECT" },
      { tagName: "DIV", isContentEditable: true },
    ]) {
      expect(press("n", {}, t).action).toBeNull();
      expect(press("c", {}, t).action).toBeNull();
      expect(press("/", {}, t).action).toBeNull();
      // Ctrl/Cmd+K stays with the Markdown editor's "insert link".
      expect(press("k", { ctrlKey: true }, t).action).toBeNull();
    }
  });

  it("still works on a checkbox or button", () => {
    expect(press("j", {}, { tagName: "INPUT", type: "checkbox", closest: () => null }).action).toBe("next-row");
    expect(press("j", {}, { tagName: "BUTTON", closest: () => null }).action).toBe("next-row");
  });

  it("stays out of dialogs, modified keys, IME composition and handled events", () => {
    expect(press("c", {}, { tagName: "BUTTON", closest: () => ({}) }).action).toBeNull();
    expect(press("c", { ctrlKey: true }).action).toBeNull();
    expect(press("d", { metaKey: true }).action).toBeNull();
    expect(press("c", { isComposing: true }).action).toBeNull();
    expect(press("c", { defaultPrevented: true }).action).toBeNull();
  });
});

describe("shortcutGroups", () => {
  const actions = (groups: ReturnType<typeof shortcutGroups>) =>
    groups.flatMap((group) => group.items.map((item) => item.action));

  it("lists the common actions", () => {
    const groups = shortcutGroups();
    expect(actions(groups)).toContain("new-issue");
    expect(actions(groups)).toContain("go-dashboard");
  });

  it("omits the dashboard for users who can't open it", () => {
    expect(actions(shortcutGroups({ dashboard: false }))).not.toContain("go-dashboard");
  });

  it("marks n and c as alternatives", () => {
    const item = shortcutGroups()
      .flatMap((group) => group.items)
      .find((spec) => spec.action === "new-issue");
    expect(item?.keys).toEqual(["n", "c"]);
    expect(item?.joiner).toBe("or");
  });
});

describe("isTypingTarget", () => {
  it("is false with no target", () => {
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("stepRow", () => {
  it("starts at the top or bottom and stays in range", () => {
    expect(stepRow(-1, 5, 1)).toBe(0);
    expect(stepRow(-1, 5, -1)).toBe(4);
    expect(stepRow(4, 5, 1)).toBe(4);
    expect(stepRow(0, 5, -1)).toBe(0);
    expect(stepRow(2, 0, 1)).toBe(-1);
  });
});
