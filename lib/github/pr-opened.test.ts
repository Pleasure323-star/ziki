import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { refreshDeliveredPullRequest } from "./pr-opened";

const PR = { pullRequestUrl: "https://github.com/o/r/pull/9", headSha: "sha-2", repositoryUrl: "https://github.com/o/r" };

function dbWith(bugs: { id: string }[]) {
  return {
    project: {
      findMany: vi.fn().mockResolvedValue([
        { id: "p1", repoUrl: "https://github.com/o/r" },
        { id: "p2", repoUrl: "https://github.com/other/repo" },
      ]),
    },
    bug: { findMany: vi.fn().mockResolvedValue(bugs), updateMany: vi.fn().mockResolvedValue({ count: bugs.length }) },
  };
}

describe("refreshDeliveredPullRequest (#delivered-step)", () => {
  it("records the new head commit on issues the pull request was delivered to", async () => {
    const db = dbWith([{ id: "bug-1" }]);
    expect(await refreshDeliveredPullRequest(PR, db as never)).toEqual(["bug-1"]);
    expect(db.bug.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: { in: ["p1"] }, isDeleted: false, pullRequestUrl: PR.pullRequestUrl },
    }));
    expect(db.bug.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["bug-1"] }, pullRequestUrl: PR.pullRequestUrl },
      data: { pullRequestHeadSha: "sha-2" },
    });
  });

  it("never attaches a pull request no issue was delivered with, whatever it names", async () => {
    const db = dbWith([]);
    expect(await refreshDeliveredPullRequest(PR, db as never)).toEqual([]);
    expect(db.bug.updateMany).not.toHaveBeenCalled();
  });

  it("does nothing for a pull request in no project's repository", async () => {
    const db = dbWith([]);
    const refreshed = await refreshDeliveredPullRequest(
      { ...PR, pullRequestUrl: "https://github.com/x/y/pull/1", repositoryUrl: "https://github.com/x/y" },
      db as never,
    );
    expect(refreshed).toEqual([]);
    expect(db.bug.findMany).not.toHaveBeenCalled();
  });
});
