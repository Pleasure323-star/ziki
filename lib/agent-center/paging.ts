export const ACTIVITY_PAGE_SIZE = 20;
export const ACTIVITY_STREAMS = ["questions", "work", "events"] as const;
export type ActivityStream = (typeof ACTIVITY_STREAMS)[number];
export type ActivityParams = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

export function activityFilters(params: ActivityParams): {
  issue: string;
  issueNumber: number | undefined;
  state: "all" | "active" | "offered" | "released";
} {
  const issue = (one(params.issue) ?? "").trim().replace(/^#/, "");
  const state = one(params.state);
  return {
    issue,
    // Invalid issue filters must match nothing, never widen the query.
    issueNumber: issue ? (/^\d+$/.test(issue) && Number.isSafeInteger(Number(issue)) && Number(issue) <= 2147483647 ? Number(issue) : -1) : undefined,
    state: state === "active" || state === "offered" || state === "released" ? state : "all",
  };
}

/** Value-based cursors survive a pending request being resolved/deleted. */
export function activityBefore(value: string | string[] | undefined) {
  const raw = one(value);
  if (!raw || raw.length > 512) return undefined;
  try {
    const [at, id] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof at !== "string" || typeof id !== "string" || !id || id.length > 191) return undefined;
    const createdAt = new Date(at);
    if (!Number.isFinite(createdAt.getTime())) return undefined;
    return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] };
  } catch {
    return undefined;
  }
}

export function activityPage<T extends { id: string; createdAt: Date }>(rows: T[]) {
  const items = rows.slice(0, ACTIVITY_PAGE_SIZE);
  const last = items.at(-1);
  return {
    items,
    next: rows.length > ACTIVITY_PAGE_SIZE && last
      ? Buffer.from(JSON.stringify([last.createdAt.toISOString(), last.id])).toString("base64url")
      : null,
  };
}

export function activityHref(params: ActivityParams, stream: ActivityStream, cursor: string | null) {
  const query = new URLSearchParams();
  for (const key of ["issue", "state", ...ACTIVITY_STREAMS]) {
    const value = key === stream ? cursor : one(params[key]);
    if (value) query.set(key, value);
  }
  return `/activity${query.size ? `?${query}` : ""}#${stream}`;
}
