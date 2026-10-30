// @vitest-environment happy-dom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AgentDecision } from "./issue-agent-activity";
import type { DecisionStage } from "@/lib/decision-stages";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { IssueProgressReport } from "./issue-progress-report";
import { IssueStageProvider } from "./issue-stage-context";

afterEach(cleanup);

const decisions: AgentDecision[] = [
  { id: "v1", at: "2026-10-21T21:30:00.000Z", kind: "confirmed", agentName: "Otter Reviewer", personName: "Ada", severity: "medium" },
  { id: "v2", at: "2026-10-21T21:12:00.000Z", kind: "rejected", agentName: "Sentinel", personName: "Bo", notes: "Possible duplicate of #422." },
  { id: "c1", at: "2026-10-22T16:08:00.000Z", kind: "claimed", agentName: "Quantum", personName: "Abuchi" },
  { id: "t1", at: "2026-10-22T17:18:00.000Z", kind: "verdict", agentName: "Mira", personName: "Ada", goodToMerge: true },
  { id: "t2", at: "2026-10-23T23:31:00.000Z", kind: "verdict", agentName: "David", personName: "Bo", goodToMerge: false },
  { id: "m1", at: "2026-10-25T09:40:00.000Z", kind: "accepted", agentName: "Merger Agent" },
  { id: "d1", at: "2026-10-25T10:20:00.000Z", kind: "deploy_failed", agentName: "Admin-Merger", reason: "The migration timed out." },
];

function renderReport(list: AgentDecision[], stage: DecisionStage) {
  return render(
    <IssueStageProvider initialStage={stage}>
      <IssueProgressReport decisions={list} currentStage={stage} setback={false} />
    </IssueStageProvider>,
  );
}

const stageButton = (label: RegExp) => screen.getByRole("button", { name: label });

describe("IssueProgressReport (#1446)", () => {
  it("marks the current stage", () => {
    renderReport(decisions, "done");
    expect(stageButton(/^Done/)).toHaveAttribute("aria-pressed", "true");
    expect(stageButton(/^Idea/)).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText(/\d+ comments?$/)).not.toBeInTheDocument();
  });

  it("shows each stage's log count and keeps ✓/✕ for screen readers", () => {
    renderReport(decisions, "done");
    expect(stageButton(/^Requires confirmation/)).toHaveTextContent("2 logs");
    expect(stageButton(/^Idea/)).toHaveTextContent("0 logs");
    expect(screen.getByText("Requires confirmation: 1 positive, 1 negative")).toBeInTheDocument();
  });

  it("has no Agent decisions card, stage footer or stage summary box", () => {
    renderReport(decisions, "done");
    expect(screen.queryByRole("region", { name: /Agent decisions/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /stage update/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^All/ })).not.toBeInTheDocument();
  });

  it("says not yet for a stage that hasn't started", () => {
    renderReport([], "idea");
    expect(stageButton(/^Live/)).toHaveTextContent("not yet");
  });
});
