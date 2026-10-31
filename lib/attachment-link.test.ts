import { describe, expect, it, vi } from "vitest";
import { linkAttachments } from "./attachment-link";

describe("linkAttachments (#215)", () => {
  it("only claims the uploader's own unlinked files", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const count = await linkAttachments({ attachment: { updateMany } } as never, {
      ids: ["a1", "a2"],
      uploaderId: "u1",
      bugId: "b1",
      commentId: "c1",
    });
    expect(count).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1", "a2"] }, uploaderId: "u1", bugId: null, ideaId: null, commentId: null, confirmationId: null },
      data: { bugId: "b1", commentId: "c1", confirmationId: null },
    });
  });

  it("does nothing without ids", async () => {
    const updateMany = vi.fn();
    await expect(
      linkAttachments({ attachment: { updateMany } } as never, { ids: [], uploaderId: "u1", bugId: "b1" }),
    ).resolves.toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("attachmentIdsInMarkdown (#305)", () => {
  it("finds pasted images and file links, once each", async () => {
    const { attachmentIdsInMarkdown } = await import("./attachment-link");
    const md = "![a](/api/attachments/clabc12345) and [log](/api/attachments/cldef67890) and ![a](/api/attachments/clabc12345)";
    expect(attachmentIdsInMarkdown(md)).toEqual(["clabc12345", "cldef67890"]);
    expect(attachmentIdsInMarkdown("no files")).toEqual([]);
    expect(attachmentIdsInMarkdown(null)).toEqual([]);
  });
});
