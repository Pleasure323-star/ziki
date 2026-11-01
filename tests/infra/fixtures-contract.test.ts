import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STATUS_OF } from "@/lib/issue-substatus";

/**
 * The checked-in local fixtures (scripts/dev/fixtures/local-ziki.json) load
 * into every test database. They must cover every step an issue can be at,
 * point only at rows they contain, and hold no real people.
 */
type Row = Record<string, unknown>;
const fx = JSON.parse(readFileSync(path.join(process.cwd(), "scripts", "dev", "fixtures", "local-ziki.json"), "utf8")) as Record<string, Row[]> & { login: { email: string } };
const ids = (name: string) => new Set(fx[name].map((row) => String(row.id)));

describe("the local fixtures", () => {
  it("have at least 200 issues, at every substatus, each under its main status", () => {
    expect(fx.bugs.length).toBeGreaterThanOrEqual(200);
    const seen = new Set(fx.bugs.map((bug) => String(bug.substatus)));
    for (const substatus of Object.keys(STATUS_OF)) expect(seen.has(substatus), substatus).toBe(true);
    for (const bug of fx.bugs) expect(bug.status, String(bug.number)).toBe(STATUS_OF[bug.substatus as keyof typeof STATUS_OF]);
  });

  it("number issues and ideas 1 to N, each issue from a converted idea", () => {
    const numbers = (rows: Row[]) => rows.map((row) => Number(row.number)).sort((a, b) => a - b);
    expect(numbers(fx.bugs)).toEqual(fx.bugs.map((_, i) => i + 1));
    expect(numbers(fx.ideas)).toEqual(fx.ideas.map((_, i) => i + 1));
    const converted = new Set(fx.ideas.filter((idea) => idea.status === "converted").map((idea) => idea.issueId));
    for (const bug of fx.bugs) expect(converted.has(bug.id), String(bug.number)).toBe(true);
  });

  it("point only at rows they contain", () => {
    const users = ids("users");
    const agents = ids("agents");
    const bugs = ids("bugs");
    const bids = ids("bids");
    const claims = ids("claims");
    const check = (table: string, field: string, set: Set<string>) => {
      for (const row of fx[table]) if (row[field] != null) expect(set.has(String(row[field])), `${table}.${field} ${row[field]}`).toBe(true);
    };
    for (const table of ["confirmations", "bids", "claims", "deliveries", "testVerdicts", "mergeReviews", "pullRequestReports", "comments", "votes", "activities", "bidVotes"]) check(table, "bugId", bugs);
    for (const table of ["confirmations", "bids", "claims", "deliveries", "testVerdicts", "mergeReviews", "pullRequestReports", "comments", "votes", "bidVotes", "ideaVerdicts"]) check(table, "agentId", agents);
    check("bids", "claimId", claims);
    check("bidVotes", "bidId", bids);
    check("bugs", "duplicateOfId", bugs);
    check("bugs", "assigneeId", users);
    check("comments", "parentId", ids("comments"));
  });

  it("hold no real people: every account is a made-up @fixtures.local one", () => {
    for (const user of fx.users) expect(String(user.email)).toMatch(/@fixtures\.local$/);
    expect(fx.login.email).toMatch(/@fixtures\.local$/);
  });
});
