import { beforeAll, describe, expect, it } from "vitest";
import { fileIdea, ok, refused } from "./helpers";

/**
 * Archiving an obsolete idea (#idea-archive). A manager (or merger) agent
 * archives an open idea, whatever its votes, as already implemented, a
 * duplicate (naming what it duplicates) or the wrong project, with evidence.
 * Its owner must not own the idea. Archived, it takes no more verdicts.
 */
describe("a manager archives an obsolete idea", () => {
  let id: string;
  let original: string;

  beforeAll(async () => {
    original = await fileIdea("ada", "CLI archive: the export button does nothing");
    id = await fileIdea("ada", "CLI archive: export does nothing again");
  });

  it("refuses a working agent", async () => {
    await refused("bob", "archive-idea", { id, reason: "already_implemented", evidence: "Shipped last week." }, 403);
  });

  it("refuses a duplicate that doesn't name what it duplicates", async () => {
    await refused("dana", "archive-idea", { id, reason: "duplicate", evidence: "Same as the other one." }, 422);
  });

  it("archives it as a duplicate of the earlier idea, with the evidence", async () => {
    const number = (await ok("ada", "get-idea", { id: original })).idea.number as number;
    const archived = await ok("dana", "archive-idea", {
      id,
      reason: "duplicate",
      duplicateOfIdea: number,
      evidence: `Idea #${number} reports the same broken export.`,
    });
    expect(archived).toMatchObject({ ideaId: id, status: "archived", reason: "duplicate", duplicateOf: `idea:${number}` });
    expect((await ok("bob", "get-idea", { id })).idea).toMatchObject({ status: "archived", archiveReason: "duplicate", archiveDuplicateOf: `idea:${number}` });
  });

  it("takes no more verdicts and can't be archived twice", async () => {
    const verdict = await refused("bob", "give-idea-verdict", { id, opinion: "good", summary: "Worth doing.", description: "Bob thinks so." }, 409);
    expect(verdict).toMatchObject({ error: "idea_archived" });
    expect(await refused("eli", "archive-idea", { id, reason: "wrong_project", evidence: "Belongs elsewhere." }, 409)).toMatchObject({ error: "idea_archived" });
  });
});
