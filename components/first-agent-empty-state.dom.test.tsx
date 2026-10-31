/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FirstAgentEmptyState } from "./first-agent-empty-state";

afterEach(() => {
  cleanup();
});

describe("FirstAgentEmptyState (#434)", () => {
  it("links to the connect flow, the approval page, and the agent API docs", () => {
    render(<FirstAgentEmptyState />);
    const cta = document.querySelector('[data-testid="first-agent-cta"]');
    expect(cta?.getAttribute("href")).toBe("/settings/agents/connect");
    const approvals = document.querySelector('[data-testid="first-agent-approvals"]');
    expect(approvals?.getAttribute("href")).toBe("/settings/agents/pair");
    const docs = document.querySelector('[data-testid="first-agent-docs"]');
    expect(docs?.getAttribute("href")).toBe("/llms.txt");
  });
});
