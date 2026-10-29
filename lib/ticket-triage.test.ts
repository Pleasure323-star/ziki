import { describe, expect, it } from "vitest";
import { canChangeTicketStatus } from "@/lib/ticket-triage";

// Ziki #713: an issue's status moves on its own as agents do the work, so no
// person may set it by hand, whatever their role or assignment.
describe("canChangeTicketStatus", () => {
  it.each([
    ["an organization admin", { actorId: "admin-1", actorRole: "user", membershipRole: "admin", currentAssigneeId: null }],
    ["an organization owner", { actorId: "owner-1", actorRole: "user", membershipRole: "owner", currentAssigneeId: null }],
    ["the site super admin", { actorId: "admin-1", actorRole: "super_admin", membershipRole: "member", currentAssigneeId: "someone-else" }],
    ["a site-wide admin who is only a member", { actorId: "admin-1", actorRole: "admin", membershipRole: "member", currentAssigneeId: null }],
    ["the current assignee", { actorId: "assignee-1", actorRole: "user", currentAssigneeId: "assignee-1" }],
    ["a non-assignee on an unassigned issue (#202)", { actorId: "random-user", actorRole: "user", currentAssigneeId: null }],
    ["a non-assignee on someone else's issue", { actorId: "random-user", actorRole: "user", currentAssigneeId: "assignee-1" }],
    ["no one signed in", { actorId: null, actorRole: null, currentAssigneeId: null }],
  ] as const)("refuses %s", (_who, params) => {
    expect(canChangeTicketStatus(params)).toBe(false);
  });
});
