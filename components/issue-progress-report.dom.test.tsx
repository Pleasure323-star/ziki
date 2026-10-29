// @vitest-environment happy-dom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { CommentNode } from "@/lib/comments";
import type { AgentDecision } from "./issue-agent-activity";
import { stageOfComment, stageStarts, type DecisionStage } from "@/lib/decision-stages";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/app/actions/comments", () => ({
  deleteCommentAction: vi.fn(),
  updateCommentAction: vi.fn(),
  createCommentAction: vi.fn(),
}));
vi.mock("@/components/comment-form", () => ({
  CommentForm: () => <form aria-label="Add comment" />,
}));

import { IssueProgressReport } from "./issue-progress-report";
import { IssueStageProvider } from "./issue-stage-context";
import { IssueStageSummary } from "./issue-stage-summary";
import { StageCommentThread, StageConversationCount } from "./stage-comment-thread";

afterEach(cleanup);

const decisions: AgentDecision[] = [
  { id: "v1", at: "2026-10-21T21:30:00.000Z", kind: "confirmed", agentName: "Otter Reviewer", personName: "Ada", severity: "medium" },
  { id: "v2", at: "2026-10-21T21:12:00.000Z", kind: "rejected", agentName: "Sentinel", personName: "Bo", notes: "Possible duplicate of #422." },
  { id: "c1", at: "2026-10-22T16:08:00.000Z", kind: "claimed", agentName: "Quantum", personName: "Abuchi" },
  { id: "t1", at: "2026-10-22T17:18:00.000Z", kind: "verdict", agentName: "Mira", personName: "Ada", goodToMerge: true },
  { id: "t2", at: "2026-10-23T23:31:00.000Z", kind: "verdict", agentName: "David", personName: "Bo", goodToMerge: false },
  { id: "m1", at: "2026-10-25T09:40:00.000Z", kind: "accepted", agentName: "Merger Agent" },
  { id: "d1", at: "2026-10-25T10:20:00.000Z", kind: "deploy_failed", agentName: "Admin-Merger", reason: "The migration timed out." },
  { id: "d2", at: "2026-10-25T11:05:00.000Z", kind: "accepted", agentName: "Admin-Merger", merged: true },
];

function comment(id: string, type: CommentNode["type"], body: string, createdAt: string): CommentNode {
  return {
    id,
    authorId: "u1",
    parentId: null,
    body,
    type,
    createdAt,
    depth: 0,
    author: { name: "Someone", role: "user" },
    parent: null,
    children: [],
  };
}

const comments = [
  comment("k1", "review", "Idea review comment", "2026-10-21T20:00:00.000Z"),
  comment("k2", "bid", "Bid comment", "2026-10-22T13:00:00.000Z"),
  comment("k3", "review", "Fix review comment", "2026-10-23T17:00:00.000Z"),
  comment("k4", "comment", "Plain comment after the claim", "2026-10-22T16:30:00.000Z"),
];

function renderPage(
  list: AgentDecision[],
  stage: DecisionStage,
  threadComments = comments,
  {
    setback = false,
    pullRequestUrl = null as string | null,
    ideaVerdicts = undefined as
      | { score: number; threshold: number; votes: { good: number; bad: number; neutral: number } }
      | undefined,
  } = {},
) {
  const starts = stageStarts(list);
  const counts: Record<DecisionStage, number> = { idea: 0, confirm: 0, open: 0, done: 0, ready: 0, live: 0 };
  for (const c of threadComments) counts[stageOfComment(c.type, c.createdAt, starts)] += 1;
  return render(
    <IssueStageProvider initialStage={stage}>
      <IssueProgressReport decisions={list} currentStage={stage} setback={setback} commentCounts={counts} />
      <h2>
        Conversation <span data-testid="conv-count"><StageConversationCount counts={counts} fallback={threadComments.length} /></span>
      </h2>
      <IssueStageSummary
        decisions={list}
        currentStage={stage}
        setback={setback}
        pullRequestUrl={pullRequestUrl}
        severity="medium"
        ideaVerdicts={ideaVerdicts}
      />
      <StageCommentThread
        bugId="b1"
        issueUrl="https://example.com/issues/1"
        reporterId="u1"
        users={[]}
        comments={threadComments}
        stage={stage}
        stageStarts={starts}
      />
    </IssueStageProvider>,
  );
}

const summary = (label: string) => within(screen.getByRole("group", { name: `${label} stage update` }));
const stageButton = (label: RegExp) => screen.getByRole("button", { name: label });

describe("IssueProgressReport (#1446)", () => {
  it("opens on the active stage with its summary and comments only", () => {
    renderPage(decisions, "done");

    expect(stageButton(/^Done/)).toHaveAttribute("aria-pressed", "true");
    expect(stageButton(/^Idea/)).toHaveAttribute("aria-pressed", "false");

    expect(summary("Done").getByText("1 Good to merge")).toBeInTheDocument();
    expect(summary("Done").getByText("1 Not good to merge")).toBeInTheDocument();
    expect(summary("Done").queryByText(/Confirmed/)).not.toBeInTheDocument();

    expect(screen.getByText("Fix review comment")).toBeInTheDocument();
    expect(screen.queryByText("Idea review comment")).not.toBeInTheDocument();
    expect(screen.queryByText("Plain comment after the claim")).not.toBeInTheDocument();
    expect(screen.getByTestId("conv-count")).toHaveTextContent("1");
  });

  it("shows the stage's log count and keeps ✓/✕ for screen readers", () => {
    renderPage(decisions, "done");
    expect(stageButton(/^Requires confirmation/)).toHaveTextContent("2 logs");
    expect(stageButton(/^Idea/)).toHaveTextContent("0 logs");
    expect(screen.getByText("Requires confirmation: 1 positive, 1 negative")).toBeInTheDocument();
    expect(screen.getByText("Ready to merge: 1 positive, 1 negative")).toBeInTheDocument();
  });

  it("has no Agent decisions card or stage footer any more (#186)", () => {
    renderPage(decisions, "done");
    expect(screen.queryByRole("region", { name: /Agent decisions/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Testing logs and good / not good to merge verdicts")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^All/ })).not.toBeInTheDocument();
  });

  it("summarises manager and merger agent decisions under their stages", () => {
    renderPage(decisions, "live");
    expect(summary("Live").getByText("1 Deployed")).toBeInTheDocument();
    expect(summary("Live").getByText("Merged and deployed.")).toBeInTheDocument();
    fireEvent.click(stageButton(/^Ready to merge/));
    expect(summary("Ready to merge").getByText("1 Ready to merge")).toBeInTheDocument();
    expect(summary("Ready to merge").getByText("1 Deployment failed")).toBeInTheDocument();
    expect(
      summary("Ready to merge").getByText("Manager agent marked it ready to merge. 1 deployment failed."),
    ).toBeInTheDocument();
  });

  it("puts a plain comment in the stage it was posted in and switches the summary", () => {
    renderPage(decisions, "done");
    fireEvent.click(stageButton(/^Open/));

    expect(summary("Open").getByText("1 Claimed")).toBeInTheDocument();
    expect(screen.getByText("Plain comment after the claim")).toBeInTheDocument();
    expect(screen.getByText("Bid comment")).toBeInTheDocument();
    expect(screen.queryByText("Fix review comment")).not.toBeInTheDocument();
    expect(screen.getByTestId("conv-count")).toHaveTextContent("2");
  });

  it("shows the design's empty Idea stage when there are no logs or comments", () => {
    renderPage([], "idea", []);

    expect(stageButton(/^Idea/)).toHaveTextContent("0 logs");
    expect(stageButton(/^Live/)).toHaveTextContent("not yet");
    expect(summary("Idea").getByText("People give the idea good, bad or neutral verdicts; a manager agent then converts it to an issue.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("No comments at the Idea stage yet.");
    expect(screen.getByTestId("conv-count")).toHaveTextContent("0");
  });
});

describe("IssueStageSummary (#186)", () => {
  it("shows the stage's up and down totals and, on the Idea stage, the verdicts", () => {
    renderPage(decisions, "idea", comments, { ideaVerdicts: { score: 2, threshold: 3, votes: { good: 3, bad: 1, neutral: 2 } } });
    const totals = within(screen.getByLabelText("Idea stage totals"));
    // Confirmations belong to the next stage now (#714), so the Idea stage counts none.
    expect(totals.getByTitle("0 agent decisions up")).toHaveTextContent("0 up");
    expect(totals.getByTestId("idea-verdict-totals")).toHaveTextContent("Score 2 of 3 · 3 good · 1 bad · 2 neutral");
    expect(totals.queryByText(/upvote/)).toBeNull();

    fireEvent.click(stageButton(/^Requires confirmation/));
    const confirm = within(screen.getByLabelText("Requires confirmation stage totals"));
    expect(confirm.getByTitle("1 agent decision up")).toHaveTextContent("1 up");
    expect(confirm.getByTitle("1 agent decision down")).toHaveTextContent("1 down");
    expect(confirm.queryByTestId("idea-verdict-totals")).toBeNull();

    fireEvent.click(stageButton(/^Done/));
    const done = within(screen.getByLabelText("Done stage totals"));
    expect(done.getByTitle("1 agent decision up")).toBeInTheDocument();
    expect(done.getByTitle("1 agent decision down")).toBeInTheDocument();
    expect(done.queryByTestId("idea-verdict-totals")).toBeNull();
  });

  it("shows zero totals on a stage with no decisions yet", () => {
    renderPage([], "idea", [], { ideaVerdicts: { score: 0, threshold: 3, votes: { good: 0, bad: 0, neutral: 0 } } });
    const totals = within(screen.getByLabelText("Idea stage totals"));
    expect(totals.getByTitle("0 agent decisions up")).toHaveTextContent("0 up");
    expect(totals.getByTitle("0 agent decisions down")).toHaveTextContent("0 down");
    expect(totals.getByTestId("idea-verdict-totals")).toHaveTextContent("Score 0 of 3 · 0 good · 0 bad · 0 neutral");
  });

  it("marks each stage Complete, In progress or Not reached against the current one", () => {
    renderPage(decisions, "done");
    expect(summary("Done").getByText("In progress")).toBeInTheDocument();
    fireEvent.click(stageButton(/^Idea/));
    expect(summary("Idea").getByText("Complete")).toBeInTheDocument();
    fireEvent.click(stageButton(/^Live/));
    expect(summary("Live").getByText("Not reached")).toBeInTheDocument();
  });

  it("says Sent back after a setback, with what has to happen next", () => {
    renderPage(decisions, "done", comments, { setback: true });
    const done = summary("Done");
    expect(done.getByText("Sent back")).toBeInTheDocument();
    expect(done.getByText("1 agent said good to merge, 1 agent said not good to merge. Sent back for changes.")).toBeInTheDocument();
    expect(done.getByText("Pending")).toBeInTheDocument();
    expect(done.getByText("Fix the findings and resubmit the pull request")).toBeInTheDocument();
  });

  it("summarises Requires confirmation with counts, severity and the latest decision (#714)", () => {
    renderPage(decisions, "confirm");
    const idea = summary("Requires confirmation");
    expect(idea.getByText("Confirmed as real and not a duplicate by 1 reviewer, severity Medium. 1 reviewer rejected it.")).toBeInTheDocument();
    expect(idea.getByText("1 Confirmed")).toBeInTheDocument();
    expect(idea.getByText("1 Rejected")).toBeInTheDocument();
    // Latest is the newest by time, not by list order.
    expect(idea.getByText(/^Latest/)).toHaveTextContent("Otter Reviewer");
  });

  it("lists testing as pending when a PR is in but nobody has tested it", () => {
    const early = decisions.filter((d) => d.kind === "confirmed" || d.kind === "claimed");
    renderPage(early, "done", [], { pullRequestUrl: "https://github.com/emerjent/ziki/pull/1275" });
    const done = summary("Done");
    expect(done.getByText("PR #1275 is submitted. No agent has tested it yet.")).toBeInTheDocument();
    expect(done.getByText("Testing by reviewer agents")).toBeInTheDocument();
    expect(done.getByText("Good or not good to merge verdict")).toBeInTheDocument();
    expect(done.queryByText(/^Latest/)).not.toBeInTheDocument();
  });

  it("shows nothing pending for a completed stage and the start rule for one not reached", () => {
    renderPage(decisions, "ready");
    fireEvent.click(stageButton(/^Open/));
    expect(summary("Open").getByText("Nothing pending at this stage.")).toBeInTheDocument();
    expect(summary("Open").queryByText("Pending")).not.toBeInTheDocument();
    fireEvent.click(stageButton(/^Live/));
    // The admin merger's deploy is in the list, so Live shows its decision even before the stage is current.
    expect(summary("Live").getByText("Not reached")).toBeInTheDocument();
  });

  it("explains when a stage starts if it has nothing yet", () => {
    renderPage([], "idea", []);
    fireEvent.click(stageButton(/^Ready to merge/));
    expect(summary("Ready to merge").getByText("Starts once testing marks the fix good to merge.")).toBeInTheDocument();
    expect(summary("Ready to merge").queryByText("Nothing pending at this stage.")).not.toBeInTheDocument();
  });
});
