import { describe, expect, it } from "vitest";
import { planNotifications, type NotificationEvent } from "./notifications";

const SITE = "https://ziki.dev";
const ISSUE = "/ziki/12";
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
      null,
    );

    expect(planned).toMatchObject({
      userId: "owner-1",
      kind: "reviewer_eligible",
      url: "/settings/agents",
    });
  });

  it("emails each mentioned user once, never the author", () => {
    const event: NotificationEvent = {
      ...base,
      kind: "mentioned",
      place: "comment",
      recipientIds: ["bob", "alice", "bob", "cara"],
      excerpt: "@Bob can you check?",
    };
    const planned = planNotifications(event, SITE, ISSUE);
    expect(planned.map((p) => p.userId)).toEqual(["bob", "cara"]);
    expect(planned[0]?.text).toContain("@Bob can you check?");
    expect(planned[0]?.text).toContain("https://ziki.dev/ziki/12");
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
    const planned = planNotifications(event, SITE, ISSUE);
    expect(planned[0]?.url).toBe("/ziki/12?comment=c9#comment-c9");
    expect(planned[0]?.text).toContain("https://ziki.dev/ziki/12?comment=c9#comment-c9");
  });

  it("tells the new and the previous assignee", () => {
    const planned = planNotifications(
      { ...base, kind: "assignee_changed", fromUserId: "cara", toUserId: "bob" },
      SITE,
      ISSUE,
    );
    expect(planned.map((p) => p.userId)).toEqual(["bob", "cara"]);
  });

  it("explains a take-over to the previous assignee", () => {
    const planned = planNotifications(
      { ...base, kind: "assignee_changed", fromUserId: "cara", toUserId: "alice" },
      SITE,
      ISSUE,
    );
    expect(planned.map((p) => p.userId)).toEqual(["cara"]);
  });

  it("tells someone they were unassigned", () => {
    const planned = planNotifications(
      { ...base, kind: "assignee_changed", fromUserId: "cara", toUserId: null },
      SITE,
      ISSUE,
    );
    expect(planned.map((p) => p.userId)).toEqual(["cara"]);
  });

  it("doesn't notify when the assignee didn't change or you assign yourself", () => {
    expect(planNotifications({ ...base, kind: "assignee_changed", fromUserId: "bob", toUserId: "bob" }, SITE, ISSUE)).toEqual([]);
    expect(planNotifications({ ...base, kind: "assignee_changed", fromUserId: null, toUserId: "alice" }, SITE, ISSUE)).toEqual([]);
  });

  it("tells the reporter about status changes, except their own", () => {
    const planned = planNotifications(
      { ...base, kind: "status_changed", reporterId: "bob", from: "open", to: "resolved" },
      SITE,
      ISSUE,
    );
    expect(planned).toHaveLength(1);
    expect(
      planNotifications({ ...base, kind: "status_changed", reporterId: "alice", from: "open", to: "closed" }, SITE, ISSUE),
    ).toEqual([]);
  });

  it("truncates long titles in subjects", () => {
    const planned = planNotifications(
      { ...base, bugTitle: "x".repeat(120), kind: "status_changed", reporterId: "bob", from: "open", to: "closed" },
      SITE,
      ISSUE,
    );
    expect(planned[0]?.subject.length).toBeLessThan(120);
  });
});

describe("comment and watcher notifications (#216)", () => {
  const base = { actorId: "alice", actorName: "Alice", bugId: "b1", bugTitle: "Login button does nothing" };

  it("tells every watcher about a new comment, except the commenter", () => {
    const planned = planNotifications(
      { ...base, kind: "comment_added", commentId: "c9", excerpt: "Still broken on Safari", recipientIds: ["bob", "alice", "cara"] },
      SITE,
      ISSUE,
    );
    expect(planned.map((p) => p.userId)).toEqual(["bob", "cara"]);
    expect(planned[0]?.text).toContain("Still broken on Safari");
  });

  it("links straight to the comment, in email and in the feed", () => {
    const [n] = planNotifications(
      { ...base, kind: "comment_added", commentId: "c9", recipientIds: ["bob"] },
      SITE,
      ISSUE,
    );
    expect(n?.url).toBe("/ziki/12?comment=c9#comment-c9");
    expect(n?.text).toContain("https://ziki.dev/ziki/12?comment=c9#comment-c9");
  });

  it("tells the parent comment's author about the reply separately from other watchers", () => {
    const planned = planNotifications(
      { ...base, kind: "comment_added", commentId: "c9", parentAuthorId: "cara", recipientIds: ["bob", "cara"] },
      SITE,
      ISSUE,
    );
    expect(planned.find((p) => p.userId === "cara")?.title).not.toBe(planned.find((p) => p.userId === "bob")?.title);
    expect(planned).toHaveLength(2);
  });

  it("skips people already notified by a mention in the same comment", () => {
    const planned = planNotifications(
      { ...base, kind: "comment_added", commentId: "c9", recipientIds: ["bob", "cara"], excludeIds: ["bob"] },
      SITE,
      ISSUE,
    );
    expect(planned.map((p) => p.userId)).toEqual(["cara"]);
  });

  it("sends status changes to watchers, with a different message for the reporter", () => {
    const planned = planNotifications(
      { ...base, kind: "status_changed", reporterId: "bob", from: "open", to: "resolved", recipientIds: ["bob", "cara"] },
      SITE,
      ISSUE,
    );
    expect(planned.map((p) => p.userId)).toEqual(["bob", "cara"]);
    expect(planned[0]?.text).not.toBe(planned[1]?.text);
  });

  it("every planned notification carries a feed title and link", () => {
    const planned = planNotifications(
      { ...base, kind: "assignee_changed", fromUserId: null, toUserId: "bob" },
      SITE,
      ISSUE,
    );
    expect(planned[0]).toMatchObject({ kind: "assignee_changed", url: "/ziki/12" });
    expect(planned[0]?.title).toBeTruthy();
  });
});

describe("resolution note in the status email (#316)", () => {
  const resolved = { ...base, kind: "status_changed", reporterId: "bob", from: "open", to: "resolved" } as const;

  it("includes the note when there is one", () => {
    const [planned] = planNotifications({ ...resolved, note: "Fixed in 2.4." }, SITE, ISSUE);
    expect(planned?.text).toContain("Fixed in 2.4.");
  });
});
