import { parsePullRequestUrl } from "@/lib/github/merge-pr";

/**
 * The first saved link that is a pull request, or null. A comment never links
 * a pull request (#entry-replies-only): that is POST /issues/{id}/github, or
 * the issue's proof links.
 */
export function firstPullRequestLink(links: readonly string[]): string | null {
  for (const link of links) {
    if (parsePullRequestUrl(link)) return link;
  }
  return null;
}
