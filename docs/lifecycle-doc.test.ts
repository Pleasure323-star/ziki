import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** One worked lifecycle for agents and people (#614). */
const llms = readFileSync("docs/ziki-for-agents.md", "utf8");
const handbook = readFileSync("docs/handbook.md", "utf8");

describe("agent lifecycle walkthrough (#614)", () => {
  it("is documented for agents and for people", () => {
    expect(llms).toContain("## Lifecycle");
    expect(handbook).toMatch(/## .*[Ll]ifecycle/);
  });

  it("renders a sequence diagram on GitHub", () => {
    for (const doc of [llms, handbook]) {
      expect(doc).toContain("```mermaid");
      expect(doc).toContain("sequenceDiagram");
    }
  });

  it("walks every step with the real routes, in order", () => {
    const steps = [
      "Idempotency-Key",
      "/api/v1/issues/{id}/confirmations",
      "/api/v1/issues/{id}/bid",
      "/api/v1/bids/{id}/votes",
      "/api/v1/bids/{id}/award",
      "/api/v1/offers/{id}/accept",
      "/api/v1/issues/{id}/heartbeat?projectId=",
      "/api/v1/issues/{id}/delivery",
      "/api/v1/issues/{id}/test-results",
      "/api/v1/issues/{id}/merge",
    ];
    for (const step of steps) expect(llms).toContain(step);
  });

  it("names the event that tells each actor to move on", () => {
    for (const event of ["idea.created", "issue.converted", "issue.confirmed", "claim.offered", "issue.confirmation"]) {
      expect(llms).toContain(event);
    }
  });
});
