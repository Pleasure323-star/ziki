import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The public llms.txt must describe the code as it actually behaves (#554, #559, #560, #562). */
const doc = readFileSync("docs/ziki-for-agents.md", "utf8");

describe("llms.txt accuracy", () => {
  it("contains only agent-facing material (#562)", () => {
    expect(doc).not.toContain("Acceptance Checklist");
    expect(doc).not.toContain("Backfill dry-run was executed");
    expect(doc).not.toContain("bug numbers are unchanged by the schema migration");
    expect(doc).not.toContain("satisfies the acceptance criteria");
  });

  it("documents the offer → accept flow (#554)", () => {
    expect(doc).toContain("/api/v1/issues/{id}/offer");
    expect(doc).toContain("/api/v1/offers/{id}/accept");
    expect(doc).toMatch(/30 min|30 minutes|1800 s|1800 seconds/i);
    expect(doc).toContain("410");
  });

  it("documents the heartbeat call that works as written (#560)", () => {
    expect(doc).toContain("/api/v1/issues/{id}/heartbeat?projectId=");
    expect(doc).toContain('"claim":');
    expect(doc).toContain("503");
  });

  it("documents webhook signing well enough to verify a delivery (#559)", () => {
    for (const needle of [
      "X-Ziki-Timestamp",
      "X-Ziki-Signature",
      "X-Ziki-Delivery",
      'timestamp + "." + rawBody',
      "5 minutes",
      "auto-disabled",
    ]) {
      expect(doc).toContain(needle);
    }
  });

  it("documents the agent inbox and every item kind (#601)", async () => {
    const { INBOX_KINDS } = await import("@/lib/agent-api/inbox");
    expect(doc).toContain("GET /api/v1/inbox");
    expect(doc).toContain("POST /api/v1/inbox/read");
    expect(doc).toContain("unread=1");
    expect(doc).toContain("upTo");
    for (const kind of INBOX_KINDS) expect(doc).toContain(`| \`${kind}\` |`);
  });

  it("defines agent persona, user interaction protocol, and capability explanation (#756)", () => {
    expect(doc).toContain("Agent Persona & Interaction Protocol");
    expect(doc).toContain("Introduction & Ziki Briefing");
    expect(doc).toContain("Capability Explanation");
    expect(doc).toContain("Acting Without Waiting for the Owner");
    expect(doc).toMatch(/autonomous software development agent on Ziki/i);
    expect(doc).toMatch(/collaborative issue tracking and bounty platform/i);
    // Agents bid and accept offers without asking their owner first (#678).
    expect(doc).not.toMatch(/Should I submit a bid on this issue for you\?/i);
    expect(doc).not.toMatch(/waits for the owner's affirmative response/i);
    expect(doc).toMatch(/Never drop work silently/);
  });

  it("documents agent PR completion callback workflow (#746)", () => {
    expect(doc).toContain("Execute the completion callback");
    expect(doc).toContain("POST /api/v1/issues/{id}/github");
    expect(doc).toContain("issue.pr_linked");
  });

  it("documents feed area filter, areaId, and cross-reference (#472)", () => {
    expect(doc).toMatch(/`area` \(optional\): a project area id, or `none`/);
    expect(doc).toMatch(/"areaId": "area_\.\.\."/);
    expect(doc).toContain("See [Feed & Polling](#feed--polling) above");
  });

  it("documents common agent errors and recovery (#468)", () => {
    expect(doc).toContain("## Common Agent Errors and Recovery");
    expect(doc).toContain("[Common Agent Errors and Recovery](#common-agent-errors-and-recovery)");

    const errorNeedles = [
      "missing_key",
      "invalid_key",
      "revoked",
      "project_forbidden",
      "insufficient_level",
      "authorization_pending",
      "expired_token",
      "used_token",
      "invalid_grant",
      "Send your agent key as Authorization: Bearer <key>.",
      "That agent key is not valid. Send it as Authorization: Bearer <key>.",
      "That agent key has been revoked.",
      "Waiting for your owner to approve the code.",
      "idea_converted",
      "below_threshold",
      "This issue has a pending offer.",
      "This person already has the maximum number of active tasks.",
      "Accept an offer or have your bid awarded before linking a fix.",
      "The delivery deadline has passed.",
      "You're doing that too fast. Please wait a moment.",
      "No such API route. See /llms.txt.",
      "Method not allowed.",
    ];
    for (const needle of errorNeedles) {
      expect(doc).toContain(needle);
    }
  });

  it("links every common error to an existing route or guide section (#468)", () => {
    const errorSectionStart = doc.indexOf("## Common Agent Errors and Recovery");
    expect(errorSectionStart).toBeGreaterThan(-1);
    const errorSection = doc.slice(errorSectionStart, doc.indexOf("\n---\n", errorSectionStart));
    const anchors = [...errorSection.matchAll(/\[[^\]]+\]\(#([^)]+)\)/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(10);

    const normalizedHeadings = [...doc.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) =>
      m[1]
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-"),
    );

    for (const anchor of anchors) {
      expect(
        normalizedHeadings,
        `Anchor #${anchor} in Common Errors table should point to a real heading in llms.txt`,
      ).toContain(anchor);
    }
  });

  it("documents 404 for unknown split targets and 400 for self-funding (#507)", () => {
    expect(doc).toContain("Refusals: `404` for unknown targets; `400` for a goal funding itself");
  });
});
