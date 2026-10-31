/**
 * Site-wide keyboard shortcuts (#287). Pure decision logic: the provider in
 * components/keyboard-shortcuts.tsx listens for keys and carries out what
 * `shortcutFor` returns.
 *
 * Nothing here fires while someone is typing: inputs, selects, textareas
 * (the Markdown editor and its own shortcuts in lib/editor-shortcuts.ts),
 * contenteditable regions and open dialogs are all left alone, as is any
 * key pressed with Ctrl, ⌘ or Alt.
 */

export type ShortcutAction =
  | "focus-search"
  | "next-row"
  | "previous-row"
  | "new-issue"
  | "go-issues"
  | "go-dashboard"
  | "go-notifications"
  | "show-help";

export type ShortcutSpec = {
  keys: string[];
  label: string;
  action: ShortcutAction | "open-row" | "leave-search";
  /** Keys are alternatives ("or") rather than a sequence ("then"). */
  joiner?: "then" | "or";
};

export type ShortcutOptions = {
  /** The dashboard is the organization overview (/org), so it's hidden for anyone without one. */
  dashboard?: boolean;
};

/**
 * What the cheat sheet lists, in order. The dashboard entry is omitted when
 * the signed-in user has no organization, since /org would have nothing to show.
 */
export function shortcutGroups({
  dashboard = true,
}: ShortcutOptions = {}): { title: string; items: ShortcutSpec[] }[] {
  const anywhere: ShortcutSpec[] = [
    { keys: ["n", "c"], label: "Report a new issue", action: "new-issue", joiner: "or" },
    { keys: ["Ctrl/Cmd+K"], label: "Search", action: "focus-search" },
    { keys: ["g", "i"], label: "Go to issues", action: "go-issues" },
  ];
  if (dashboard) {
    anywhere.push({ keys: ["g", "d"], label: "Go to dashboard", action: "go-dashboard" });
  }
  anywhere.push(
    { keys: ["g", "n"], label: "Go to notifications", action: "go-notifications" },
    { keys: ["?"], label: "Show these shortcuts", action: "show-help" },
  );

  return [
    {
      title: "Issues list",
      items: [
        { keys: ["/"], label: "Search", action: "focus-search" },
        { keys: ["Esc"], label: "Leave the search box", action: "leave-search" },
        { keys: ["j"], label: "Next issue", action: "next-row" },
        { keys: ["k"], label: "Previous issue", action: "previous-row" },
        { keys: ["Enter"], label: "Open the selected issue", action: "open-row" },
      ],
    },
    { title: "Anywhere", items: anywhere },
  ];
}

/** How long after `g` the second key still counts. */
export const SEQUENCE_TIMEOUT_MS = 1200;

export type KeyEventLike = {
  key: string;
  /** Physical key, so Ctrl/Cmd+K also works on non-Latin layouts. */
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
};

export type TargetLike = {
  tagName?: string;
  isContentEditable?: boolean;
  type?: string;
  closest?: (selector: string) => unknown;
} | null;

const TEXT_INPUT_TYPES = new Set([
  "", "text", "search", "email", "url", "tel", "password", "number", "date", "time", "datetime-local", "month", "week",
]);

/** True when the key belongs to whatever the person is typing into. */
export function isTypingTarget(target: TargetLike): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") return TEXT_INPUT_TYPES.has((target.type ?? "").toLowerCase());
  if (target.isContentEditable) return true;
  // Dialogs (confirm, the cheat sheet itself) own their keys; so does any
  // widget that opts out explicitly.
  return Boolean(target.closest?.('dialog[open], [role="dialog"], [role="alertdialog"], [data-shortcuts-ignore]'));
}

export type SequenceState = { pending: "g" | null; at: number };

export const IDLE: SequenceState = { pending: null, at: 0 };

/**
 * The action for one key press, and the sequence state after it. Returns
 * no action for anything that isn't a shortcut, so the key behaves normally.
 */
export function shortcutFor(
  event: KeyEventLike,
  target: TargetLike,
  state: SequenceState,
  now: number,
  { dashboard = true }: ShortcutOptions = {},
): { action: ShortcutAction | null; state: SequenceState } {
  if (event.defaultPrevented || event.isComposing) return { action: null, state: IDLE };
  if (event.altKey) return { action: null, state: IDLE };

  // Enter, Space and every plain key belong to whatever is focused. Letting
  // the editor keep Ctrl/Cmd+K for "insert link" avoids stealing it.
  if (isTypingTarget(target)) return { action: null, state: IDLE };

  if (event.ctrlKey || event.metaKey) {
    // `code` covers layouts where K isn't the letter produced (e.g. Cyrillic).
    if (event.key.toLowerCase() === "k" || event.code === "KeyK") {
      return { action: "focus-search", state: IDLE };
    }
    return { action: null, state: IDLE };
  }

  const key = event.key;
  if (state.pending === "g" && now - state.at <= SEQUENCE_TIMEOUT_MS) {
    if (key === "i") return { action: "go-issues", state: IDLE };
    if (key === "n") return { action: "go-notifications", state: IDLE };
    if (key === "d" && dashboard) return { action: "go-dashboard", state: IDLE };
  }
  switch (key) {
    case "/":
      return { action: "focus-search", state: IDLE };
    case "j":
      return { action: "next-row", state: IDLE };
    case "k":
      return { action: "previous-row", state: IDLE };
    case "n":
    case "c":
      return { action: "new-issue", state: IDLE };
    case "?":
      return { action: "show-help", state: IDLE };
    case "g":
      return { action: null, state: { pending: "g", at: now } };
    default:
      return { action: null, state: IDLE };
  }
}

/** Index of the row to move to, staying inside the list. */
export function stepRow(current: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, current + direction));
}

/** Window event that opens the cheat sheet from anywhere (e.g. Settings). */
export const SHOW_SHORTCUTS_EVENT = "zedu:show-shortcuts";
