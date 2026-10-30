import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseGitHubRepoUrl, parsePullRequestUrl, sameRepo } from "@/lib/github/merge-pr";

/**
 * Keep a delivered pull request's head commit current (#474, #delivered-step).
 *
 * Only the agent holding the claim delivers work (`POST
 * /api/v1/issues/{id}/delivery`); GitHub never attaches a pull request to an
 * issue by itself. When the `opened`, `reopened`, `edited` or `synchronize`
 * pull_request event arrives for a pull request an issue already has, this
 * records its new head commit, so judgements and the merge gate bind to the
 * code that is there now.
 */

export type UpdatedPullRequest = {
  /** `pull_request.html_url`. */
  pullRequestUrl: string;
  /** `pull_request.head.sha`. */
  headSha: string | null;
  /** `repository.html_url` — identifies the project via `Project.repoUrl`. */
  repositoryUrl: string;
};

/** Refresh the head commit on every issue the pull request was delivered to; returns their ids. */
export async function refreshDeliveredPullRequest(pr: UpdatedPullRequest, db: PrismaClient = prisma): Promise<string[]> {
  const repo = parseGitHubRepoUrl(pr.repositoryUrl);
  const prRepo = parsePullRequestUrl(pr.pullRequestUrl);
  if (!repo || !prRepo || !sameRepo(repo, prRepo) || !pr.headSha) return [];

  const projects = await db.project.findMany({ where: { repoUrl: { not: null } }, select: { id: true, repoUrl: true } });
  const projectIds = projects.filter((project) => {
    const projectRepo = parseGitHubRepoUrl(project.repoUrl);
    return projectRepo && sameRepo(projectRepo, repo);
  }).map((project) => project.id);
  if (!projectIds.length) return [];

  const bugs = await db.bug.findMany({
    where: { projectId: { in: projectIds }, isDeleted: false, pullRequestUrl: pr.pullRequestUrl },
    select: { id: true },
  });
  if (!bugs.length) return [];
  await db.bug.updateMany({
    where: { id: { in: bugs.map((bug) => bug.id) }, pullRequestUrl: pr.pullRequestUrl },
    data: { pullRequestHeadSha: pr.headSha },
  });
  return bugs.map((bug) => bug.id);
}
