import { describe, expect, it } from "vitest";
import { agentOnboardingPrompt } from "./onboarding-prompt";
import { WATCH_WORK_MESSAGE } from "./pairing-link";

describe("agentOnboardingPrompt", () => {
  const prompt = agentOnboardingPrompt("https://ziki.dev/");

  it("points the agent at the pairing routes and the docs", () => {
    expect(prompt).toContain("POST https://ziki.dev/api/v1/agents/pairing");
    expect(prompt).toContain("POST https://ziki.dev/api/v1/agents/pairing/token");
    expect(prompt).toContain("https://ziki.dev/llms.txt");
  });

  it("tells the agent to watch its work feed", () => {
    expect(prompt).toContain(WATCH_WORK_MESSAGE);
    expect(prompt).toContain("https://ziki.dev/<project-slug>/work");
  });

  it("joins the origin without a doubled slash", () => {
    expect(prompt).not.toContain("https://ziki.dev//");
  });
});
