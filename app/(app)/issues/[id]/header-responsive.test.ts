import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(path.resolve(__dirname, "page.tsx"), "utf8");

describe("Bug detail header responsive layout (#698)", () => {
  it("has no mobile action row or header action list: the header keeps only the votes and the actions menu", () => {
    expect(pageSource).not.toContain('data-testid="mobile-actions-row"');
    expect(pageSource).not.toContain("headerActions");
    expect(pageSource).toMatch(/<h1[\s\S]*?<\/h1>[\s\S]*?<VoteButton[\s\S]*?<IssueActionsMenu>/);
  });

  it("puts Assign to me in the People box, by the assignee", () => {
    const rail = pageSource.slice(pageSource.indexOf("{/* SIDE RAIL */}"));
    const people = rail.slice(rail.indexOf(">People<"), rail.indexOf("<IssueLinks"));
    expect(people).toMatch(/Assignee[\s\S]*?canSelfAssign[\s\S]*?<SelfAssignButton/);
    const header = pageSource.slice(0, pageSource.indexOf("{/* SIDE RAIL */}"));
    expect(header).not.toContain("<SelfAssignButton");
  });

  it("shows the status alone in the rail's Status box: no severity chip, stage or opened line", () => {
    const rail = pageSource.slice(pageSource.indexOf("{/* SIDE RAIL */}"));
    const statusBox = rail.slice(rail.indexOf('aria-label="Status"'), rail.indexOf(">People<"));
    expect(statusBox).toContain("issueStatusChipClass[bug.status]");
    expect(statusBox).not.toMatch(/severity/i);
    // #requires-confirmation: Requires confirmation is the status, so no stage chip repeats it.
    expect(statusBox).not.toContain("issueStageLabels");
    expect(statusBox).not.toContain("Opened");
  });

  it("anchors the desktop action cluster to the title's top edge (#687, #451)", () => {
    expect(pageSource).toContain(
      '<div className="flex shrink-0 flex-wrap items-center gap-2 self-start print:hidden">'
    );
    expect(pageSource).toContain("Back to issues");

    expect(pageSource).not.toContain("Danger zone");
  });

  it("keeps Mark as duplicate and Delete under the actions menu at the top right", () => {
    expect(pageSource).toMatch(/<IssueActionsMenu>[\s\S]*?<MarkDuplicateButton[\s\S]*?<DeleteIssueButton[\s\S]*?<\/IssueActionsMenu>/);
  });

  it("places an accessible back link to the issues list (#451)", () => {
    // BackToList returns to the list you came from, else to this issue's status list.
    expect(pageSource).toMatch(
      /<BackToList fallback=\{`\/issues\?status=\$\{bug\.status\}`\} label="Back to issues" \/>/
    );
  });
});

describe("Bug detail header hierarchy (#687)", () => {
  it("keeps the taxonomy chips in the header, away from the workflow badges", () => {
    const header = pageSource.slice(0, pageSource.indexOf("{/* SIDE RAIL */}"));
    expect(header).toMatch(/bug\.type\.name[\s\S]*?bug\.category\.name/);
    expect(header).not.toMatch(/severity/i);
  });

  it("drops the redundant score pill so only VoteButton shows the vote total", () => {
    expect(pageSource).not.toMatch(/score \(\{/);
    expect(pageSource).not.toMatch(/\{bug\.voteCount\} score/);
  });

  it("uses a main column and side rail layout", () => {
    expect(pageSource).toContain("flex-[999_1_600px]");
    expect(pageSource).toContain("flex-[1_1_340px]");
    // The progress report sits in the main column (#1446) and the Conversation has no stage summary box; the Links box sits in the rail under People.
    const main = pageSource.slice(pageSource.indexOf("{/* MAIN COLUMN */}"), pageSource.indexOf("{/* SIDE RAIL */}"));
    expect(main).toContain("<IssueProgressReport");
    expect(main).not.toContain("<IssueStageSummary");
    const rail = pageSource.slice(pageSource.indexOf("{/* SIDE RAIL */}"));
    expect(rail.indexOf(">People<")).toBeGreaterThan(-1);
    expect(rail.indexOf("<IssueLinks")).toBeGreaterThan(rail.indexOf(">People<"));
    expect(pageSource).not.toContain("IssueSectionTabs");
  });
});

describe("an issue is never an idea (#idea-table)", () => {
  it("always shows the upvote button and the conversation: ideas have their own page", () => {
    expect(pageSource).not.toContain("isIdea");
    expect(pageSource).not.toContain("IdeaVerdictsPanel");
    expect(pageSource).toMatch(/<section\s+id="conversation"/);
    expect(pageSource).not.toContain("<UpdateIssueForm");
    expect(pageSource).not.toContain("<GoalBudgetSection");
  });

  it("links back to the idea it was converted from in the Links box, not as a header chip", () => {
    expect(pageSource).toMatch(/<IssueLinks[\s\S]*?idea=\{sourceIdea \? \{ number: sourceIdea\.number \} : null\}/);
    expect(pageSource).not.toContain("From idea #");
  });
});
