import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/notify", () => ({ notifyLater: vi.fn() }));

import {
  agentQuestionEvent,
  approvalNeededEvent,
  claimOfferedEvent,
  tenantInviteEvent,
} from "./agent-notifications";
import { planNotifications } from "./notifications";
import { safeNotificationPath } from "./notification-links";
import { shouldNotify } from "./notification-prefs";

const SITE = "https://ziki.dev";

describe("agent and platform notifications (#443)", () => {
  it("tells the owner about their agent's question, linking to it", () => {
    const planned = planNotifications(
      agentQuestionEvent({
        id: "q1",
        body: "Should I  fix\nthe header too?",
        tenantId: "workspace-1",
        ownerUserId: "owner",
        agent: { name: "Claude" },
        bugId: "b1",
        bugTitle: "Header overlaps",
      }),
      SITE,
      null,
    );
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      userId: "owner",
      kind: "agent_question",
      url: "/questions/q1",
      title: "Claude has a question for you about “Header overlaps”",
    });
    expect(planned[0]?.text).toContain("> Should I fix the header too?");
    expect(planned[0]?.text).toContain("Answer the question: https://ziki.dev/questions/q1");
    expect(
      agentQuestionEvent({
        id: "q1",
        body: "Hi",
        ownerUserId: "owner",
        tenantId: "workspace-1",
        agent: { name: "Claude" },
      }),
    ).toMatchObject({ tenantId: "workspace-1" });
  });

  it("reminds the owner of a question their agent's claim is paused on (#606)", () => {
    const [planned] = planNotifications(
      agentQuestionEvent({
        id: "q1",
        body: "Which API?",
        tenantId: "workspace-1",
        ownerUserId: "owner",
        agent: { name: "Claude" },
        bugId: "b1",
        bugTitle: "Header overlaps",
        reminder: true,
      }),
      SITE,
      null,
    );
    expect(planned).toMatchObject({
      userId: "owner",
      kind: "agent_question",
      url: "/questions/q1",
      title: "Reminder: Claude is still waiting for your answer about “Header overlaps”",
    });
    expect(planned?.text).toContain("paused until you answer");
  });

  it("asks the person a redesign was proposed for to approve it", () => {
    const planned = planNotifications(
      approvalNeededEvent({
        id: "r1",
        title: "New issue page",
        onBehalfOfUserId: "bob",
        tenantId: "workspace-1",
        agent: { name: "GPT" },
      }),
      SITE,
      null,
    );
    expect(planned.map((p) => [p.userId, p.kind, p.url])).toEqual([
      ["bob", "approval_needed", "/redesigns/r1"],
    ]);
    expect(planned[0]?.text).toContain("stays blocked until a person approves");
  });

  it("tells an invitee about the invite, but never the inviter", () => {
    const invite = {
      id: "inv 1",
      tenantId: "workspace-1",
      tenantName: "Acme",
      invitedBy: { id: "alice", name: "Alice" },
    };
    const planned = planNotifications(tenantInviteEvent({ ...invite, inviteeUserId: "cara" }), SITE, null);
    expect(planned.map((p) => [p.userId, p.url])).toEqual([["cara", "/tenants?invite=inv%201"]]);
    expect(planned[0]?.title).toBe("Alice invited you to Acme");

    expect(planNotifications(tenantInviteEvent({ ...invite, inviteeUserId: "alice" }), SITE, null)).toEqual([]);
  });

  it("tells the person named on an offer, linking to the issue", () => {
    const planned = planNotifications(
      claimOfferedEvent({ id: "c1", bugId: "b9", bugTitle: "Crash on save", beneficiaryUserId: "dan" }),
      SITE,
      "/ziki/9",
    );
    expect(planned.map((p) => [p.userId, p.kind, p.url])).toEqual([["dan", "claim_offered", "/ziki/9"]]);
    expect(planned[0]?.text).toContain("a minute to accept");
  });

  it("links only to paths inside the app", () => {
    for (const url of ["/questions/q1", "/redesigns/r1", "/tenants?invite=i1", "/issues/b1", "/ziki/9"]) {
      expect(safeNotificationPath(url)).toBe(url);
    }
  });

  it("emails the new kinds under the master switch only", () => {
    const prefs = {
      emailNotifications: true,
      notifyMentions: false,
      notifyAssignments: false,
      notifyStatusChanges: false,
    };
    for (const kind of ["agent_question", "approval_needed", "tenant_invite", "claim_offered"] as const) {
      expect(shouldNotify(prefs, kind)).toBe(true);
      expect(shouldNotify({ ...prefs, emailNotifications: false }, kind)).toBe(false);
    }
  });
});
