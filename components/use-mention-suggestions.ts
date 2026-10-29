"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  filterUsersForMention,
  getMentionQuery,
  insertMention,
  type MentionQuery,
} from "@/lib/mentions";
import { applyTextChange } from "@/lib/editor-dom";

/** `agentOwner` marks an agent option (`id` is `agent:<id>`) and names its owner (#603). */
export type MentionUser = { id: string; name: string; agentOwner?: string };

/**
 * Shared @mention autocomplete state so every editor (bug description,
 * comments and replies) behaves the same.
 */
export function useMentionSuggestions({
  users,
  value,
  onChange,
  textareaRef,
  enabled = true,
}: {
  users: MentionUser[];
  value: string;
  onChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  enabled?: boolean;
}) {
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const mentionRef = useRef<MentionQuery | null>(null);

  const effectiveMention = enabled ? mention : null;

  const suggestions = useMemo(
    () => (effectiveMention ? filterUsersForMention(users, effectiveMention.query) : []),
    [effectiveMention, users],
  );

  const clampedIndex = useMemo(() => {
    if (suggestions.length === 0) return 0;
    return Math.min(Math.max(0, activeIndex), suggestions.length - 1);
  }, [activeIndex, suggestions.length]);

  const showSuggestions = enabled && effectiveMention !== null && suggestions.length > 0;

  /**
   * Re-evaluate the mention query at a caret position.
   *
   * #201: this used to reset `activeIndex` to 0 unconditionally. Because the
   * textarea calls `sync` from `onKeyUp`, `onClick` and `onSelect` as well as
   * `onChange`, pressing ArrowDown moved the highlight and the very next
   * keyup snapped it back, so Enter always inserted the first result.
   *
   * Callers should pass `resetIndex` only for genuine typing (onChange, or
   * inserting "@" from the toolbar) - never from keyup/click/select.
   *
   * #484: moving caret between different mention spans (or when the mention
   * query changes) resets `activeIndex` to 0 so selection from an earlier
   * span is not preserved into an unrelated span.
   */
  const sync = useCallback(
    (nextValue: string, caret: number, resetIndex = false) => {
      if (!enabled) return;
      const nextMention = getMentionQuery(nextValue, caret);
      const prevMention = mentionRef.current;
      const spanChanged =
        Boolean(prevMention) !== Boolean(nextMention) ||
        (prevMention !== null &&
          nextMention !== null &&
          (prevMention.start !== nextMention.start ||
            prevMention.query !== nextMention.query));

      mentionRef.current = nextMention;
      setMention(nextMention);
      if (resetIndex || spanChanged) {
        setActiveIndex(0);
      }
    },
    [enabled],
  );

  const close = useCallback(() => {
    mentionRef.current = null;
    setMention(null);
    setActiveIndex(0);
  }, []);

  const apply = useCallback(
    (user: MentionUser) => {
      const textarea = textareaRef.current;
      if (!mention) return;
      const caret = textarea?.selectionStart ?? value.length;
      const next = insertMention(value, mention, caret, user.name, user.id);
      mentionRef.current = null;
      setMention(null);
      setActiveIndex(0);
      if (textarea) {
        applyTextChange(
          textarea,
          value,
          next.value,
          next.caret,
          next.caret,
          onChange,
        );
      } else {
        onChange(next.value);
      }
    },
    [mention, onChange, textareaRef, value],
  );

  /** Returns true when the key was consumed by the suggestion list. */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (
        !showSuggestions ||
        event.nativeEvent?.isComposing ||
        event.nativeEvent?.keyCode === 229
      ) return false;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((prev) => {
          const current = Math.min(Math.max(0, prev), suggestions.length - 1);
          return (current + 1) % suggestions.length;
        });
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((prev) => {
          const current = Math.min(Math.max(0, prev), suggestions.length - 1);
          return (current - 1 + suggestions.length) % suggestions.length;
        });
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const user = suggestions[clampedIndex];
        if (!user) return false;
        event.preventDefault();
        apply(user);
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return true;
      }
      return false;
    },
    [apply, clampedIndex, close, showSuggestions, suggestions],
  );

  return {
    mention,
    suggestions,
    activeIndex: clampedIndex,
    showSuggestions,
    sync,
    close,
    apply,
    setActiveIndex,
    handleKeyDown,
  };
}
