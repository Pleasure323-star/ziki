import { issuesPath } from "@/lib/project-paths";

/**
 * Wording for "this platform / type can't be deleted because issues use it"
 * (#314). One function for both, so the two admin pages cannot drift apart
 * again — they had already: one said "Reassign or deactivate it instead",
 * the other "Deactivate it instead", with different number formatting.
 */

export type InUseKind = "platform" | "type";

const noun = { platform: "platform", type: "issue type" } as const;

const issues = (n: number) => `${n} ${n === 1 ? "issue" : "issues"}`;

export type InUseText = {
  /** The sentence explaining why deletion was refused. */
  reason: string;
  /** Label for the link to the live issues, or null when there are none. */
  liveLink: string | null;
  /** Label for the link to the deleted ones, or null when there are none. */
  deletedLink: string | null;
};

/**
 * `total` is what blocks deletion: soft-deleted issues still hold the
 * foreign key. The list hides deleted issues, so a link labelled with the
 * total would open fewer rows than it promised — hence the split.
 */
export function inUseText({
  kind,
  name,
  total,
  deleted,
}: {
  kind: InUseKind;
  name: string;
  total: number;
  deleted: number;
}): InUseText {
  const live = Math.max(0, total - deleted);
  return {
    reason: `The ${noun[kind]} “${name}” can't be deleted because ${issues(total)} ${total === 1 ? "uses" : "use"} it.`,
    liveLink: live > 0 ? `View the ${issues(live)}` : null,
    deletedLink: deleted > 0 ? `${deleted} deleted ${deleted === 1 ? "issue" : "issues"}` : null,
  };
}

/** Where those issues are, on the existing filtered list. */
export function inUseHrefs(
  slug: string,
  kind: InUseKind,
  value: string,
): { live: string; deleted: string } {
  const param = kind === "platform" ? "platform" : "tags";
  const q = `${param}=${encodeURIComponent(value)}`;
  return { live: issuesPath(slug, "all", q), deleted: issuesPath(slug, "all", `deleted=true&${q}`) };
}
