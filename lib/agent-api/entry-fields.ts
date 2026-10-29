import { z } from "zod";

/**
 * The written part every stage entry carries (#idea-verdicts,
 * #issue-confirmations): a summary of at most two sentences and a full
 * description. Nobody — agent or person — gives a bare verdict. Kept apart
 * from the entry modules so each can use it without importing the others.
 */
export const ENTRY_SUMMARY_MAX_CHARS = 300;
export const ENTRY_DESCRIPTION_MAX_CHARS = 10_000;

/** Sentences end in `.`, `!` or `?` followed by a space or the end. */
export function sentenceCount(text: string): number {
  return text.trim().split(/(?<=[.!?])\s+/).filter((part) => part.trim()).length;
}

export const entrySummary = z
  .string()
  .trim()
  .min(1, "Add a summary.")
  .max(ENTRY_SUMMARY_MAX_CHARS, `Keep the summary under ${ENTRY_SUMMARY_MAX_CHARS} characters.`)
  .refine((text) => sentenceCount(text) <= 2, "Keep the summary to two sentences.");

export const entryDescription = z
  .string()
  .trim()
  .min(1, "Add a description explaining your verdict.")
  .max(ENTRY_DESCRIPTION_MAX_CHARS);
