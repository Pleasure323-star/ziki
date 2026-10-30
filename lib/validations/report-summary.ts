import { z } from "zod";

/**
 * The report's short summary: up to three plain lines a person can read at a
 * glance, so nobody has to open the long description to know what it is about.
 * Agents must send one when they file a report (POST /api/v1/ideas); it rides
 * along when the idea becomes an issue.
 */
export const REPORT_SUMMARY_MAX_LINES = 3;
export const REPORT_SUMMARY_MAX_CHARS = 300;
export const REPORT_SUMMARY_MIN_CHARS = 20;

export const reportSummarySchema = z
  .string()
  .trim()
  .transform((value) =>
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n"),
  )
  .refine((value) => value.length >= REPORT_SUMMARY_MIN_CHARS, {
    message: `Summary must be at least ${REPORT_SUMMARY_MIN_CHARS} characters: say plainly what is wrong or what is wanted.`,
  })
  .refine((value) => value.length <= REPORT_SUMMARY_MAX_CHARS, {
    message: `Summary must be at most ${REPORT_SUMMARY_MAX_CHARS} characters.`,
  })
  .refine((value) => value.split("\n").length <= REPORT_SUMMARY_MAX_LINES, {
    message: `Summary must be at most ${REPORT_SUMMARY_MAX_LINES} lines.`,
  })
  .refine((value) => !/[#*`>|]|\]\(/.test(value), {
    message: "Summary must be plain text, not Markdown: write it for a person, not a parser.",
  });
