// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { IssueAgentActivity, type AgentDecision } from "./issue-agent-activity";

describe("IssueAgentActivity (#448)", () => {
  beforeEach(() => cleanup());

  it("renders nothing when there is no agent activity", () => {
    const { container } = render(<IssueAgentActivity decisions={[]} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Agent decisions")).not.toBeInTheDocument();
  });

  it("shows both reviewers on a confirmed issue, and no severity", () => {
    const decisions: AgentDecision[] = [
      {
        id: "v1",
        at: "2026-01-01T10:00:00.000Z",
        kind: "confirmed",
        agentName: "reviewer-one",
        personName: "Ada",
      },
      {
        id: "v2",
        at: "2026-01-01T11:00:00.000Z",
        kind: "confirmed",
        agentName: "reviewer-two",
        personName: "Tenant Owner",
      },
    ];

    render(<IssueAgentActivity decisions={decisions} />);

    expect(screen.getByText("Agent decisions")).toBeInTheDocument();
    expect(screen.getByText("reviewer-one")).toBeInTheDocument();
    expect(screen.getByText("reviewer-two")).toBeInTheDocument();
    expect(screen.getAllByText("Confirmed")).toHaveLength(2);
    expect(screen.queryByText(/High|Medium|severity/i)).not.toBeInTheDocument();
  });

  it("shows who a claim was for, the test verdicts, and the accepted fix", () => {
    const decisions: AgentDecision[] = [
      {
        id: "c1",
        at: "2026-01-01T12:00:00.000Z",
        kind: "claimed",
        agentName: "fixer-agent",
        personName: "Bob",
      },
      {
        id: "verdict-1",
        at: "2026-01-01T13:00:00.000Z",
        kind: "verdict",
        agentName: "reviewer-one",
        personName: "Ada",
        goodToMerge: true,
      },
      {
        id: "verdict-2",
        at: "2026-01-01T14:00:00.000Z",
        kind: "verdict",
        agentName: "reviewer-two",
        personName: "Ada",
        goodToMerge: false,
      },
      {
        id: "accepted-1",
        at: "2026-01-01T15:00:00.000Z",
        kind: "accepted",
        agentName: "merger-agent",
      },
    ];

    render(<IssueAgentActivity decisions={decisions} />);

    expect(screen.getByText("fixer-agent")).toBeInTheDocument();
    expect(screen.getByText(/claimed this issue for/)).toHaveTextContent("Bob");
    expect(screen.getByText(/good to merge\.$/)).toHaveTextContent("good to merge");
    expect(screen.getByText(/not ready to merge\.$/)).toHaveTextContent("not ready to merge");
    expect(screen.getByText("merger-agent")).toBeInTheDocument();
    expect(screen.getByText(/marked this issue resolved\.$/)).toBeInTheDocument();
  });

  it("shows the delivery countdown and when the one extension was used (#593)", () => {
    const deliverBy = new Date(Date.now() + 90 * 60_000).toISOString();
    const decisions: AgentDecision[] = [
      {
        id: "c1",
        at: "2026-01-01T12:00:00.000Z",
        kind: "claimed",
        agentName: "fixer-agent",
        personName: "Bob",
        deliverBy,
        extendedAt: "2026-01-01T12:10:00.000Z",
      },
    ];

    render(<IssueAgentActivity decisions={decisions} />);

    expect(screen.getByText(/Delivery due in 1h 30m/)).toBeInTheDocument();
    expect(screen.getByText(/extension used/)).toBeInTheDocument();
  });

  it("says the claim is waiting on the owner instead of counting down (#606)", () => {
    const decisions: AgentDecision[] = [
      {
        id: "c1",
        at: "2026-01-01T12:00:00.000Z",
        kind: "claimed",
        agentName: "fixer-agent",
        personName: "Bob",
        deliverBy: new Date(Date.now() + 90 * 60_000).toISOString(),
        waitingOnName: "Mark",
      },
    ];

    render(<IssueAgentActivity decisions={decisions} />);

    expect(screen.getByText(/Waiting for Mark to answer fixer-agent's question\./)).toBeInTheDocument();
    expect(screen.queryByText(/Delivery due/)).not.toBeInTheDocument();
  });

  it("shows a rejection and its notes, and never calls it a confirmation (#1122)", () => {
    const decisions: AgentDecision[] = [
      {
        id: "validation-v1",
        at: "2026-01-01T10:00:00.000Z",
        kind: "confirmed",
        agentName: "reviewer-one",
        personName: "Ada",
      },
      {
        id: "validation-v2",
        at: "2026-01-01T11:00:00.000Z",
        kind: "rejected",
        agentName: "reviewer-two",
        personName: "Stephen",
        notes: "Could not reproduce: <b>200</b> on every list call.",
      },
    ];

    render(<IssueAgentActivity decisions={decisions} />);

    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("reviewer-one confirmed this issue as real");
    expect(items[1]).toHaveTextContent("reviewer-two found this isn't a real issue on behalf of Stephen.");
    expect(items[1]).not.toHaveTextContent("confirmed");
    // Notes are plain text, so markup in them is shown, not rendered.
    expect(within(items[1]).getByText("Could not reproduce: <b>200</b> on every list call.")).toBeInTheDocument();
  });

  it("omits the notes block for a rejection without notes", () => {
    render(
      <IssueAgentActivity
        decisions={[
          { id: "validation-v3", at: "2026-01-01T11:00:00.000Z", kind: "rejected", agentName: "reviewer-two", personName: "", notes: null },
        ]}
      />,
    );

    const item = within(screen.getByRole("list")).getByRole("listitem");
    expect(item).toHaveTextContent("reviewer-two found this isn't a real issue.");
    expect(item.querySelector("blockquote")).toBeNull();
  });

  it("lists the decisions in chronological order regardless of input order", () => {
    const decisions: AgentDecision[] = [
      {
        id: "accepted-1",
        at: "2026-01-01T15:00:00.000Z",
        kind: "accepted",
        agentName: "merger-agent",
      },
      {
        id: "c1",
        at: "2026-01-01T12:00:00.000Z",
        kind: "claimed",
        agentName: "fixer-agent",
        personName: "Bob",
      },
      {
        id: "v1",
        at: "2026-01-01T10:00:00.000Z",
        kind: "confirmed",
        agentName: "reviewer-one",
        personName: "Ada",
      },
    ];

    render(<IssueAgentActivity decisions={decisions} />);

    const list = screen.getByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("reviewer-one");
    expect(items[1]).toHaveTextContent("fixer-agent");
    expect(items[2]).toHaveTextContent("merger-agent");
  });

  it("labels a merger's rejection as not ready to merge and shows their notes (#1429)", () => {
    render(
      <IssueAgentActivity
        decisions={[
          {
            id: "mr1",
            at: "2026-01-01T10:00:00.000Z",
            kind: "merge_rejected",
            agentName: "merger-agent",
            notes: "Please add the missing migration.",
          },
        ]}
      />,
    );

    expect(screen.getByText("Not ready to merge")).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent(
      "merger-agent rejected the fix and asked for changes before it can merge.",
    );
    expect(screen.getByText("Please add the missing migration.")).toBeInTheDocument();
  });
});
