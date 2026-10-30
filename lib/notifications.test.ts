import { describe, expect, it } from "vitest";
import { planNotifications, type NotificationEvent } from "./notifications";

const SITE = "https://ziki.dev";
const base = { actorId: "alice", actorName: "Alice", bugId: "b1", bugTitle: "Login button does nothing" };

describe("planNotifications (#151)", () => {
  it("tells an agent owner when their contributor becomes reviewer-eligible (#659)", () => {
    const [planned] = planNotifications(
      {
        kind: "reviewer_eligible",
        actorId: null,
        actorName: "Agent A",
        recipientId: "owner-1",
        tenantId: "tenant-1",
      },
      SITE,
    );

    expect(planned).toMatchObject({
      userId: "owner-1",
      kind: "reviewer_eligible",
      url: "/settings/agents",
    });
    expect(planned?.subject).toContain("Agent A is eligible to become a reviewer");
    expect(planned?.text).toContain("Its current role has not changed");
  });

  it("emails each mentioned user once, never the author", () => {
    const event: NotificationEvent = {
      ...base,
      kind: "mentioned",
      place: "comment",
      recipientIds: ["bob", "alice", "bob", "cara"],
      excerpt: "@Bob can you check?",
    };
    const planned = planNotifications(event, SITE);
    expect(planned.map((p) => p.userId)).toEqual(["bob", "cara"]);
    expect(planned[0]?.subject).toBe("[Ziki Issues] Alice mentioned you on “Login button does nothing”");
    expect(planned[0]?.text).toContain("mentioned you in a comment on");
    expect(planned[0]?.text).toContain("> @Bob can you check?");
    expect(planned[0]?.text).toContain("https://ziki.dev/issues/b1");
    expect(planned[0]?.text).toContain("https://ziki.dev/settings");
  });

  it("links directly to the comment when commentId is provided for a mention (#720)", () => {
    const event: NotificationEvent = {
      ...base,
      kind: "mentioned",
      place: "comment",
      commentId: "c9",
      recipientIds: ["bob"],
      excerpt: "@Bob check this comment",
    };
    const planned = planNotifications(event, SITE);
    expect(planned[0]?.url).toBe("/issues/b1?comment=c9#comment-c9");
    expect(planned[0]?.text).toContain("https://ziki.dev/issues/b1?comment=c9#comment-c9");
  });

  it("tells the new and the previous assignee", () => {
    const planned = planNotifications(
      { ...base, kind: "assignee_changed", fromUserId: "cara", toUserId: "bob" },
      SITE,
    );
    expect(planned.map((p) => p.userId)).toEqual(["bob", "cara"]);
    expect(planned[0]?.text).toContain("assigned “Login button does nothing” to you");
    expect(planned[1]?.text).toContain("no longer assigned to you");
  });

  it("explains a take-over to the previous assignee", () => {
    const planned = planNotifications(
      { ...base, kind: "assignee_changed", fromUserId: "cara", toUserId: "alice" },
      SITE,
    );
    expect(planned.map((p) => p.userId)).toEqual(["cara"]);
    expect(planned[0]?.text).toContain("Alice took over");
  });

  it("tells someone they were unassigned", () => {
    const planned = planNotifications(
      { ...base, kind: "assignee_changed", fromUserId: "cara", toUserId: null },
      SITE,
    );
    expect(planned[0]?.text).toContain("unassigned you from");
  });

  it("doesn't notify when the assignee didn't change or you assign yourself", () => {
    expect(planNotifications({ ...base, kind: "assignee_changed", fromUserId: "bob", toUserId: "bob" }, SITE)).toEqual([]);
    expect(planNotifications({ ...base, kind: "assignee_changed", fromUserId: null, toUserId: "alice" }, SITE)).toEqual([]);
  });

  it("tells the reporter about status changes, except their own", () => {
    const planned = planNotifications(
      { ...base, kind: "status_changed", reporterId: "bob", from: "open", to: "resolved" },
      SITE,
    );
    expect(planned).toHaveLength(1);
    expect(planned[0]?.subject).toBe("[Ziki Issues] “Login button does nothing” is now Live");
    expect(planned[0]?.text).toContain("from Open to Live");
    expect(
      planNotifications({ ...base, kind: "status_changed", reporterId: "alice", from: "open", to: "closed" }, SITE),
    ).toEqual([]);
  });

  it("truncates long titles in subjects", () => {
    const planned = planNotifications(
      { ...base, bugTitle: "x".repeat(120), kind: "status_changed", reporterId: "bob", from: "open", to: "closed" },
      SITE,
    );
    expect(planned[0]?.subject.length).toBeLessThan(120);
    expect(planned[0]?.subject).toContain("…");
  });
});

describe("comment and watcher notifications (#216)", () => {
  const base = { actorId: "alice", actorName: "Alice", bugId: "b1", bugTitle: "Login button does nothing" };

  it("tells every watcher about a new comment, except the commenter", () => {
    const planned = planNotifications(
      { ...base, kind: "comment_added", commentId: "c9", excerpt: "Still broken on Safari", recipientIds: ["bob", "alice", "cara"] },
      SITE,
    );
    expect(planned.map((p) => p.userId)).toEqual(["bob", "cara"]);
    expect(planned[0]?.title).toBe("Alice commented on “Login button does nothing”");
    expect(planned[0]?.text).toContain("which you're watching");
    expect(planned[0]?.text).toContain("> Still broken on Safari");
  });

  it("links straight to the comment, in email and in the feed", () => {
    const [n] = planNotifications(
      { ...base, kind: "comment_added", commentId: "c9", recipientIds: ["bob"] },
      SITE,
    );
    expect(n?.url).toBe("/issues/b1?comment=c9#comment-c9");
    expect(n?.text).toContain("https://ziki.dev/issues/b1?comment=c9#comment-c9");
  });

  it("uses the reply wording for the parent comment's author", () => {
    const planned = planNotifications(
      { ...base, kind: "comment_added", commentId: "c9", parentAuthorId: "cara", recipientIds: ["bob", "cara"] },
      SITE,
    );
    expect(planned.find((p) => p.userId === "cara")?.title).toBe("Alice replied to your comment on “Login button does nothing”");
    expect(planned).toHaveLength(2);
  });

  it("skips people already notified by a mention in the same comment", () => {
    const planned = planNotifications(
      { ...base, kind: "comment_added", commentId: "c9", recipientIds: ["bob", "cara"], excludeIds: ["bob"] },
      SITE,
    );
    expect(planned.map((p) => p.userId)).toEqual(["cara"]);
  });

  it("sends status changes to watchers, with 'your issue' only for the reporter", () => {
    const planned = planNotifications(
      { ...base, kind: "status_changed", reporterId: "bob", from: "open", to: "resolved", recipientIds: ["bob", "cara"] },
      SITE,
    );
    expect(planned.map((p) => p.userId)).toEqual(["bob", "cara"]);
    expect(planned[0]?.text).toContain("status of your issue");
    expect(planned[1]?.text).not.toContain("your issue");
  });

  it("every planned notification carries a feed title and link", () => {
    const planned = planNotifications(
      { ...base, kind: "assignee_changed", fromUserId: null, toUserId: "bob" },
      SITE,
    );
    expect(planned[0]).toMatchObject({ kind: "assignee_changed", url: "/issues/b1", title: "Alice assigned you to “Login button does nothing”" });
  });
});

describe("resolution note in the status email (#316)", () => {
  const resolved = { ...base, kind: "status_changed", reporterId: "bob", from: "open", to: "resolved" } as const;

  it("includes the note when there is one", () => {
    const [planned] = planNotifications({ ...resolved, note: "Fixed in 2.4." }, SITE);
    expect(planned?.text).toContain("Resolution note from Alice:");
    expect(planned?.text).toContain("Fixed in 2.4.");
  });

  it("is unchanged without a note", () => {
    const [planned] = planNotifications({ ...resolved, note: null }, SITE);
    expect(planned?.text).not.toContain("Resolution note");
  });
});
