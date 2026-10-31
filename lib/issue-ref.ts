import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Readable issue references (#457). An issue lives at `/<project-slug>/<number>`
 * (#project-urls). Older links name it by its per-organisation number
 * (`/issues/123`), a prefixed form such as `/issues/ZE-123`, or its internal
 * id, and redirect there. Numbers are unique per tenant
 * (`@@unique([tenantId, number])`), so a number only means something inside
 * the viewer's organisation.
 */
export type IssueRef = { kind: "number"; number: number } | { kind: "id"; id: string };

const NUMBER = /^[0-9]{1,9}$/;
const PREFIXED = /^[A-Za-z][A-Za-z0-9]{0,9}-([0-9]{1,9})$/;

export function parseIssueRef(raw: string): IssueRef {
  let value = raw.trim();
  try {
    value = decodeURIComponent(value).trim();
  } catch {
    // A malformed escape is just an id that will not be found.
  }
  const prefixed = PREFIXED.exec(value);
  const digits = prefixed ? prefixed[1] : NUMBER.test(value) ? value : null;
  if (digits !== null) {
    const number = Number(digits);
    if (Number.isSafeInteger(number) && number > 0) return { kind: "number", number };
  }
  return { kind: "id", id: value };
}

/**
 * The address of an issue: its project's slug and its organisation-wide
 * number, e.g. `/ziki/123` or `/ziki/123/history` (#project-urls). Older
 * `/issues/<n>` and `/issues/<id>` links redirect here.
 */
export function issuePath(projectSlug: string, number: number, suffix = ""): string {
  return `/${encodeURIComponent(projectSlug)}/${number}${suffix}`;
}

/** The address of an issue read with `project: { select: { slug: true } }`. */
export function issueHref(issue: { number: number; project: { slug: string } }, suffix = ""): string {
  return issuePath(issue.project.slug, issue.number, suffix);
}

/** The readable path for an idea, e.g. `/ideas/12`. Ideas are numbered apart from issues (#idea-table). */
export function ideaPath(number: number): string {
  return `/ideas/${number}`;
}

type Scope = { tenantId?: Prisma.BugWhereInput["tenantId"] };
type Db = Pick<PrismaClient, "bug"> | Prisma.TransactionClient;

/**
 * Resolves a route reference to the issue's internal id and number inside
 * `scope`. A number needs a tenant: without one it is ambiguous across
 * organisations, so it resolves to nothing. An id keeps the old lookup, scope
 * included, so authorization is the same as before.
 */
export async function resolveIssueRef(
  db: Db,
  ref: IssueRef,
  scope: Scope,
): Promise<{ id: string; number: number } | null> {
  if (ref.kind === "number") {
    if (!scope.tenantId) return null;
    return db.bug.findFirst({ where: { number: ref.number, tenantId: scope.tenantId }, select: { id: true, number: true } });
  }
  return db.bug.findUnique({ where: { id: ref.id, ...scope }, select: { id: true, number: true } });
}

/**
 * The internal id a route's `{id}` names inside a tenant (#457): an id as it
 * is, a readable number (`123`, `ZE-123`) looked up in the tenant. Null when
 * no issue there has that number. Every `/api/v1/issues/{id}` route takes
 * either; the caller still scopes its own read by tenant and project.
 */
export async function issueIdFor(db: Db, raw: string, tenantId: string): Promise<string | null> {
  const ref = parseIssueRef(raw);
  if (ref.kind === "id") return ref.id;
  return (await resolveIssueRef(db, ref, { tenantId }))?.id ?? null;
}

/** `?a=1&b=2` from a page's searchParams, or "" when there are none. */
export function queryString(params: Record<string, string | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) search.append(key, item);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
