import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ attachment: { findUnique: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
import { readableAttachment } from "./attachment-read";

const agent = { tenantId: "t1", ownerId: "owner" };
const file = { uploaderId: "owner", filename: "shot.png", contentType: "image/png", size: 3, data: Buffer.from([1, 2, 3]), bug: null, idea: null, comment: null, redesignProposal: null };

beforeEach(() => vi.resetAllMocks());

describe("readableAttachment (#722)", () => {
  it("reads a file on an issue, an idea or a comment in the agent's tenant", async () => {
    for (const parent of [{ bug: { tenantId: "t1", isDeleted: false } }, { idea: { tenantId: "t1", isDeleted: false } }, { comment: { deletedAt: null, bug: { tenantId: "t1", isDeleted: false } } }]) {
      db.attachment.findUnique.mockResolvedValue({ ...file, uploaderId: "someone-else", ...parent });
      expect(await readableAttachment(agent, "f1")).toMatchObject({ filename: "shot.png", contentType: "image/png" });
    }
  });

  it("refuses another tenant's file, a deleted issue's and a deleted comment's", async () => {
    for (const parent of [{ bug: { tenantId: "t2", isDeleted: false } }, { bug: { tenantId: "t1", isDeleted: true } }, { comment: { deletedAt: new Date(), bug: { tenantId: "t1", isDeleted: false } } }]) {
      db.attachment.findUnique.mockResolvedValue({ ...file, ...parent });
      expect(await readableAttachment(agent, "f1")).toBeNull();
    }
  });

  it("reads an unattached upload only for the owner who uploaded it", async () => {
    db.attachment.findUnique.mockResolvedValue(file);
    expect(await readableAttachment(agent, "f1")).not.toBeNull();
    expect(await readableAttachment({ tenantId: "t1", ownerId: "other" }, "f1")).toBeNull();
  });

  it("is null for an unknown id", async () => {
    db.attachment.findUnique.mockResolvedValue(null);
    expect(await readableAttachment(agent, "missing")).toBeNull();
  });
});
