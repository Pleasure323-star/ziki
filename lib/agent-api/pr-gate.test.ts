import { describe, expect, it } from "vitest";
import { linkStateFromUrl, prGate, reportWanted, REPORT_STALE_HOURS, type GateReport } from "./pr-gate";

const REPO = { owner: "emerjent", repo: "ziki" };
const PR = "https://github.com/emerjent/ziki/pull/700";
const issue = (over: Partial<{ pullRequestUrl: string | null; pullRequestHeadSha: string | null }> = {}) => ({
  pullRequestUrl: PR,
  pullRequestHeadSha: "aaaaaaa",
  repo: REPO,
  ...over,
});
const report = (over: Partial<GateReport> = {}): GateReport => ({
  pullRequestUrl: PR,
  state: "open",
  mergedInto: null,
  inDefaultBranch: null,
  headSha: "aaaaaaa",
  checks: "passing",
  mergeable: true,
  ...over,
});

describe("linkStateFromUrl", () => {
  it("tells the link from the URL and the project's repository", () => {
    expect(linkStateFromUrl(null, REPO)).toBe("missing");
    expect(linkStateFromUrl(PR, null)).toBe("unknown");
    expect(linkStateFromUrl(PR, REPO)).toBe("ok");
    expect(linkStateFromUrl("https://github.com/zeduchat/bug-tracker/pull/7", REPO)).toBe("old_repository");
    expect(linkStateFromUrl("https://github.com/someone/fork/pull/7", REPO)).toBe("other_repository");
    expect(linkStateFromUrl("https://example.com/x", REPO)).toBe("other_repository");
  });
});

describe("prGate (#pr-reports)", () => {
  it("needs a report before anything but delivery", () => {
    expect(prGate(null, issue())).toMatchObject({ canDeliver: true, canAccept: false, canReconcile: false, needsReport: true, broken: null });
  });

  it("ignores a report on another address", () => {
    expect(prGate(report({ pullRequestUrl: "https://github.com/emerjent/ziki/pull/1" }), issue())).toMatchObject({ needsReport: true, canAccept: false });
  });

  it("sends a link outside the repository to repair, whatever is reported", () => {
    expect(prGate(report(), issue({ pullRequestUrl: "https://github.com/zeduchat/bug-tracker/pull/7" }))).toMatchObject({ broken: "old_repository", canDeliver: false, needsReport: false });
    expect(prGate(null, issue({ pullRequestUrl: "https://github.com/someone/fork/pull/7" }))).toMatchObject({ broken: "other_repository" });
  });

  it("lets an open, passing pull request at Ziki's head be accepted", () => {
    expect(prGate(report(), issue())).toMatchObject({ canDeliver: true, canAccept: true, needsReport: false, reason: null });
    expect(prGate(report({ checks: "none" }), issue())).toMatchObject({ canAccept: true });
  });

  it("asks for a new report when the head moved since the last one", () => {
    const gate = prGate(report({ headSha: "bbbbbbb" }), issue());
    expect(gate).toMatchObject({ canAccept: false, needsReport: true });
    expect(gate.reason).toContain("head moved");
  });

  it("refuses an accept on failing checks or a conflict, without asking for a report", () => {
    expect(prGate(report({ checks: "failing" }), issue())).toMatchObject({ canDeliver: true, canAccept: false, needsReport: false });
    expect(prGate(report({ mergeable: false }), issue())).toMatchObject({ canAccept: false, needsReport: false });
  });

  it("asks again while checks run or when they weren't reported", () => {
    expect(prGate(report({ checks: "pending" }), issue())).toMatchObject({ canAccept: false, needsReport: true });
    expect(prGate(report({ checks: null }), issue())).toMatchObject({ canAccept: false, needsReport: true });
  });

  it("resolves a merge the default branch contains, and waits for a release otherwise", () => {
    expect(prGate(report({ state: "merged", mergedInto: "main", inDefaultBranch: true }), issue())).toMatchObject({ canReconcile: true, canDeliver: false, canAccept: false, awaitingRelease: false });
    const staging = prGate(report({ state: "merged", mergedInto: "staging", inDefaultBranch: false }), issue());
    expect(staging).toMatchObject({ canReconcile: false, awaitingRelease: true, canAccept: false });
    expect(staging.reason).toContain("staging");
    expect(prGate(report({ state: "merged", inDefaultBranch: null }), issue())).toMatchObject({ needsReport: true, canReconcile: false });
  });

  it("marks a missing or closed pull request broken", () => {
    expect(prGate(report({ state: "not_found" }), issue())).toMatchObject({ broken: "not_found", canDeliver: false });
    expect(prGate(report({ state: "closed" }), issue())).toMatchObject({ broken: "closed_unmerged", canDeliver: false });
  });

  it("has nothing to say without a linked pull request", () => {
    expect(prGate(null, issue({ pullRequestUrl: null }))).toMatchObject({ canDeliver: false, needsReport: false, broken: null });
  });
});

describe("reportWanted", () => {
  const now = Date.parse("2026-10-31T12:00:00Z");
  const at = (hoursAgo: number) => ({ createdAt: new Date(now - hoursAgo * 3_600_000) });

  it("asks when nobody reported, when the gate needs one, or when the report is old", () => {
    expect(reportWanted(prGate(null, issue()), null, now)).toMatch(/Nobody has reported/);
    expect(reportWanted(prGate(report({ checks: "pending" }), issue()), at(1), now)).toMatch(/still running/);
    expect(reportWanted(prGate(report(), issue()), at(REPORT_STALE_HOURS + 1), now)).toMatch(/hours old/);
    expect(reportWanted(prGate(report(), issue()), at(1), now)).toBeNull();
  });

  it("doesn't ask about a link that must be repaired first", () => {
    expect(reportWanted(prGate(null, issue({ pullRequestUrl: "https://github.com/zeduchat/bug-tracker/pull/7" })), null, now)).toBeNull();
  });
});
