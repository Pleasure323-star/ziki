import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(path.resolve(__dirname, "page.tsx"), "utf8");

describe("Bug detail header responsive layout (#698)", () => {
  it("renders a compact mobile action row pinned directly under the title before the votes", () => {
    expect(pageSource).toMatch(
      /<h1[\s\S]*?<\/h1>[\s\S]*?data-testid="mobile-actions-row"[\s\S]*?<VoteButton/
    );

    const mobileRowMatch = pageSource.match(
      /data-testid="mobile-actions-row"[\s\S]*?className="([^"]+)"/
    );
    expect(mobileRowMatch).toBeTruthy();
    const mobileClasses = mobileRowMatch![1];
    expect(mobileClasses).toContain("overflow-x-auto");
    expect(mobileClasses).toContain("sm:hidden");
    expect(mobileClasses).toContain("flex");
    expect(mobileClasses).toContain("gap-2");
  });

  it("includes SelfAssignButton in the header action row so Assign is immediately reachable", () => {
    expect(pageSource).toMatch(
      /headerActions[\s\S]*?canSelfAssign[\s\S]*?<SelfAssignButton/
    );
  });

  it("shows status, severity and the opened date together in the rail's Status box, and no separate stage", () => {
    const rail = pageSource.slice(pageSource.indexOf("{/* SIDE RAIL */}"));
    const statusBox = rail.slice(rail.indexOf('aria-label="Status"'), rail.indexOf(">People<"));
    expect(statusBox).toContain("issueStatusChipClass[bug.status]");
    expect(statusBox).toContain("issueSeverityChipClass[bug.severity]");
    // #requires-confirmation: Requires confirmation is the status, so no stage chip repeats it.
    expect(statusBox).not.toContain("issueStageLabels");
    expect(statusBox).toMatch(/Opened[\s\S]*?<LocalTime compact date=\{bug\.createdAt\}/);
  });

  it("anchors the desktop action cluster to the title's top edge (#687, #451)", () => {
    expect(pageSource).toContain(
      '<div className="flex shrink-0 flex-wrap items-center gap-2 self-start print:hidden">'
    );
    expect(pageSource).toContain("Back to issues");

    expect(pageSource).toMatch(/Danger zone[\s\S]*?<DeleteIssueButton/);
  });

  it("places an accessible back link to the issues list (#451)", () => {
    expect(pageSource).toMatch(
      /href="\/issues"[\s\S]*?aria-label="Back to issues"/
    );
  });
});

describe("Bug detail header hierarchy (#687)", () => {
  it("keeps the taxonomy chips in the header, away from the workflow badges", () => {
    const header = pageSource.slice(0, pageSource.indexOf("{/* SIDE RAIL */}"));
    expect(header).toMatch(/bug\.type\.name[\s\S]*?bug\.category\.name/);
    expect(header).not.toContain("issueSeverityChipClass[bug.severity]");
  });

  it("drops the redundant score pill so only VoteButton shows the vote total", () => {
    expect(pageSource).not.toMatch(/score \(\{/);
    expect(pageSource).not.toMatch(/\{bug\.voteCount\} score/);
  });

  it("uses a main column and side rail layout", () => {
    expect(pageSource).toContain("flex-[999_1_600px]");
    expect(pageSource).toContain("flex-[1_1_340px]");
    // The progress report and the Conversation's stage summary sit in the main column (#1446, #186); the GitHub PR box sits in the rail under People.
    const main = pageSource.slice(pageSource.indexOf("{/* MAIN COLUMN */}"), pageSource.indexOf("{/* SIDE RAIL */}"));
    expect(main).toContain("<IssueProgressReport");
    expect(main).toContain("<IssueStageSummary");
    const rail = pageSource.slice(pageSource.indexOf("{/* SIDE RAIL */}"));
    expect(rail.indexOf(">People<")).toBeGreaterThan(-1);
    expect(rail.indexOf("<EditableProofLinks")).toBeGreaterThan(rail.indexOf(">People<"));
    expect(pageSource).not.toContain("IssueSectionTabs");
  });
});

describe("an issue is never an idea (#idea-table)", () => {
  it("always shows the upvote button and the conversation: ideas have their own page", () => {
    expect(pageSource).not.toContain("isIdea");
    expect(pageSource).not.toContain("IdeaVerdictsPanel");
    expect(pageSource).toMatch(/<section\s+id="conversation"/);
  });

  it("links back to the idea it was converted from", () => {
    expect(pageSource).toMatch(/sourceIdea \? \(\s*<Link\s+href=\{ideaPath\(sourceIdea\.number\)\}/);
  });
});
