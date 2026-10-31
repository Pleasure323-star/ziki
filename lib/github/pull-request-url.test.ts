import { describe, expect, it } from "vitest";
import { parseGitHubRepoUrl, parsePullRequestUrl, sameRepo } from "./pull-request-url";

describe("parseGitHubRepoUrl (#452)", () => {
  it("reads https and scp-style GitHub URLs, ignoring .git", () => {
    expect(parseGitHubRepoUrl("https://github.com/zedu/web.git")).toEqual({ owner: "zedu", repo: "web" });
    expect(parseGitHubRepoUrl("https://github.com/zedu/web")).toEqual({ owner: "zedu", repo: "web" });
    expect(parseGitHubRepoUrl("git@github.com:zedu/web.git")).toEqual({ owner: "zedu", repo: "web" });
  });

  it("rejects other hosts and empty input", () => {
    expect(parseGitHubRepoUrl("https://gitlab.com/zedu/web")).toBeNull();
    expect(parseGitHubRepoUrl("not a url")).toBeNull();
    expect(parseGitHubRepoUrl(null)).toBeNull();
  });
});

describe("parsePullRequestUrl (#452)", () => {
  it("reads a pull request URL", () => {
    expect(parsePullRequestUrl("https://github.com/zedu/web/pull/7")).toEqual({
      owner: "zedu",
      repo: "web",
      number: 7,
    });
  });

  it("rejects non-PR and non-GitHub URLs", () => {
    expect(parsePullRequestUrl("https://github.com/zedu/web")).toBeNull();
    expect(parsePullRequestUrl("https://gitlab.com/zedu/web/pull/7")).toBeNull();
  });
});

describe("sameRepo (#452)", () => {
  it("compares case-insensitively", () => {
    expect(sameRepo({ owner: "Zedu", repo: "Web" }, { owner: "zedu", repo: "web" })).toBe(true);
    expect(sameRepo({ owner: "zedu", repo: "web" }, { owner: "zedu", repo: "desktop" })).toBe(false);
  });
});
