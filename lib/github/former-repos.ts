import { parseGitHubRepoUrl, sameRepo, type RepoRef } from "@/lib/github/merge-pr";

/**
 * Names a project's repository had before it was renamed on GitHub, keyed by
 * its current `owner/repo`. GitHub redirects a renamed repository, so pull
 * request N under a former name is pull request N under the current one. The
 * one list: `POST /issues/{id}/pull-request` reads it, and the migration
 * `20261226000000_canonical_pr_urls` rewrote the same names in SQL.
 */
export const FORMER_REPOSITORY_NAMES: Readonly<Record<string, readonly string[]>> = {
  "emerjent/ziki": ["Zedu-Endor/issue-tracker", "zeduchat/bug-tracker", "emerjent/bug-tracker"],
};

/** True when `candidate` is a former name of the repository `current`. */
export function isFormerNameOf(candidate: RepoRef, current: RepoRef): boolean {
  const key = Object.keys(FORMER_REPOSITORY_NAMES).find((name) => {
    const ref = parseGitHubRepoUrl(`https://github.com/${name}`);
    return ref !== null && sameRepo(ref, current);
  });
  if (!key) return false;
  return FORMER_REPOSITORY_NAMES[key].some((name) => {
    const ref = parseGitHubRepoUrl(`https://github.com/${name}`);
    return ref !== null && sameRepo(ref, candidate);
  });
}
