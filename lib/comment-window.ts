import type { Prisma, PrismaClient } from "@prisma/client";
import type { FlatComment } from "@/lib/comments";

/**
 * Loading an issue's comments a window at a time (#280).
 *
 * The page used to load every comment, with author and parent, on every
 * render. Now it loads the most recent `COMMENT_THREADS_PER_PAGE` threads —
 * a root comment and all of its replies — and offers "Show earlier".
 *
 * Whole threads, not single comments: cutting a thread in the middle would
 * show replies without what they reply to.
 */

export const COMMENT_THREADS_PER_PAGE = 50;
/** `?threads=all` still has a ceiling, so a URL can't ask for a million. */
export const MAX_COMMENT_THREADS = 2000;
/** Replies nest at most MAX_COMMENT_DEPTH; this only guards bad data. */
const MAX_LEVELS = 10;

export const THREADS_PARAM = "threads";
export const COMMENT_PARAM = "comment";

/** `?threads=` → how many threads to show. Bad input gets the default. */
export function parseThreadWindow(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === "all") return MAX_COMMENT_THREADS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < COMMENT_THREADS_PER_PAGE) return COMMENT_THREADS_PER_PAGE;
  return Math.min(n, MAX_COMMENT_THREADS);
}

/** `?comment=` → a comment id worth looking up, or null. */
export function parseCommentTarget(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

/**
 * The link to an issue's comment that works whether or not the comment is
 * in the default window: the query makes the server include its thread,
 * the fragment scrolls to it.
 */
export function commentPermalinkPath(bugId: string, commentId: string): string {
  return `/issues/${bugId}?${COMMENT_PARAM}=${encodeURIComponent(commentId)}#comment-${commentId}`;
}

type Db = Pick<PrismaClient, "comment"> | Pick<Prisma.TransactionClient, "comment">;

export type CommentWindow = {
  comments: FlatComment[];
  /** Threads shown. */
  shownThreads: number;
  /** Threads older than the window. */
  hiddenThreads: number;
  /** Non-deleted comments on the issue, shown or not. */
  visibleCount: number;
};

const commentInclude = {
  author: { select: { name: true, role: true, image: true } },
  agent: { select: { name: true } },
  parent: {
    select: {
      id: true,
      body: true,
      deletedAt: true,
      author: { select: { name: true, role: true } },
    },
  },
} satisfies Prisma.CommentInclude;

/** A conversation thread's root: not a reply, and not under a stage entry. */
const THREAD_ROOT = {
  parentId: null,
  confirmationId: null,
  bidId: null,
  testVerdictId: null,
  mergeReviewId: null,
} as const;

/** The root comment of `commentId`'s thread on this issue, or null. */
async function rootOf(db: Db, bugId: string, commentId: string) {
  let current = await db.comment.findFirst({
    where: { id: commentId, bugId },
    select: { id: true, parentId: true, createdAt: true },
  });
  for (let i = 0; current?.parentId && i < MAX_LEVELS; i++) {
    current = await db.comment.findFirst({
      where: { id: current.parentId, bugId },
      select: { id: true, parentId: true, createdAt: true },
    });
  }
  return current && !current.parentId ? current : null;
}

export async function loadCommentWindow(
  db: Db,
  bugId: string,
  options: { threads: number; target?: string | null },
): Promise<CommentWindow> {
  // Replies to a confirmation entry (#issue-confirmations), a bid
  // (#issue-bids), a test verdict or a merge review (#review-entries) show
  // under their entry, not in the conversation's threads.
  const [totalThreads, visibleCount] = await Promise.all([
    db.comment.count({ where: { bugId, ...THREAD_ROOT } }),
    db.comment.count({ where: { bugId, deletedAt: null } }),
  ]);

  // A permalink to a comment outside the window widens the window down to
  // its thread, so the link lands on it and what's between stays in order.
  let take = options.threads;
  if (options.target) {
    const root = await rootOf(db, bugId, options.target);
    if (root) {
      const fromRoot = await db.comment.count({
        where: {
          bugId,
          ...THREAD_ROOT,
          OR: [
            { createdAt: { gt: root.createdAt } },
            { createdAt: root.createdAt, id: { gte: root.id } },
          ],
        },
      });
      take = Math.max(take, Math.min(fromRoot, MAX_COMMENT_THREADS));
    }
  }

  const roots = await db.comment.findMany({
    where: { bugId, ...THREAD_ROOT },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: { id: true },
  });

  // Gather each level of replies by id only, then load everything once.
  const ids = roots.map((r) => r.id);
  let frontier = ids;
  for (let level = 0; frontier.length > 0 && level < MAX_LEVELS; level++) {
    const children = await db.comment.findMany({
      where: { bugId, parentId: { in: frontier } },
      select: { id: true },
    });
    frontier = children.map((c) => c.id);
    ids.push(...frontier);
  }

  const comments =
    ids.length === 0
      ? []
      : await db.comment.findMany({
          where: { id: { in: ids } },
          include: commentInclude,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });

  return {
    comments,
    shownThreads: roots.length,
    hiddenThreads: Math.max(0, totalThreads - roots.length),
    visibleCount,
  };
}

/** The href for "Show earlier", keeping the page's other params. */
export function earlierThreadsHref(
  current: URLSearchParams,
  shown: number,
  all = false,
): string {
  const params = new URLSearchParams(current);
  params.delete(COMMENT_PARAM);
  params.set(THREADS_PARAM, all ? "all" : String(shown + COMMENT_THREADS_PER_PAGE));
  return `?${params.toString()}#comments`;
}
