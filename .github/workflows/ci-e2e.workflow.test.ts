import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** CI e2e must exercise the agent platform, not its disabled state (#588). */
const ci = readFileSync(".github/workflows/ci.yml", "utf8");

describe("e2e agent-platform coverage (#588)", () => {
  it("turns the agent platform on for the e2e job", () => {
    expect(ci).toContain('AGENT_PLATFORM: "true"');
    expect(ci).toContain('NEXT_PUBLIC_AGENT_PLATFORM: "true"');
  });

  it("provides a dummy webhook signing key", () => {
    const match = /WEBHOOK_SECRET_KEY:\s*"([a-f0-9]{64})"/.exec(ci);
    expect(match).not.toBeNull();
  });
});
