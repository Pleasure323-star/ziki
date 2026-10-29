import type { Status } from "@prisma/client";

/**
 * "Is it one of these?" while a reporter types a title (#284).
 *
 * Advisory only: nothing here blocks a report. The lookup asks Postgres
 * for trigram matches on open issues' titles (the GIN index from #217
 * serves `%` and `<%`), and this module decides what is worth showing.
 */

export const SIMILAR_LIMIT = 3;

/** Shorter than this and almost every title is "similar". */
export const MIN_QUERY_LENGTH = 8;

/**
 * Below this score a match is noise. Trigram similarity of two unrelated
 * English titles sits around 0.1–0.25; real duplicates score 0.45+.
 */
export const MIN_SCORE = 0.35;

/** Typing is debounced; this only stops a script hammering the database. */
export const SIMILAR_RATE_LIMIT = { max: 60, windowMs: 60 * 1000 };

/** Only issues someone could still be reporting a duplicate of. */
export const SIMILAR_STATUSES: readonly Status[] = ["requires_confirmation", "open", "in_progress"];

export const MAX_QUERY_LENGTH = 200;

export function normalizeQuery(raw: string | null | undefined): string {
  return (raw ?? "").normalize("NFC").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

export function shouldSearch(query: string): boolean {
  return query.length >= MIN_QUERY_LENGTH && /[\p{L}\p{N}]{3}/u.test(query);
}

export type SimilarIssue = {
  id: string;
  number: number;
  title: string;
  status: Status;
  voteCount: number;
  /** Set when the match is an open idea rather than an issue (#idea-table); its number is an idea number. */
  kind?: "issue" | "idea";
};

export type ScoredIssue = SimilarIssue & { score: number };

/** Drops weak matches, keeps the best few, best first. */
export function pickSimilar(rows: ScoredIssue[], limit = SIMILAR_LIMIT): SimilarIssue[] {
  return rows
    .filter((r) => Number(r.score) >= MIN_SCORE)
    .sort((a, b) => Number(b.score) - Number(a.score) || b.voteCount - a.voteCount)
    .slice(0, limit)
    .map(({ id, number, title, status, voteCount, kind }) => ({ id, number, title, status, voteCount, ...(kind ? { kind } : {}) }));
}

/** Words the fallback (no pg_trgm) search requires, all of them. */
export function fallbackTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4);
  return [...new Set(words)].slice(0, 5);
}
