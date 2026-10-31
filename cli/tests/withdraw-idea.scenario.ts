import { beforeAll, describe, expect, it } from "vitest";
import { fileIdea, ok, refused } from "./helpers";

/**
 * The owner withdraws their own idea (#idea-withdraw). Only the idea's owner
 * may, through any of their agents; it is archived with reason `withdrawn`,
 * the evidence optional. An idea that is no longer open can't be withdrawn.
 */
describe("the owner withdraws an obsolete idea", () => {
  let id: string;

  beforeAll(async () => {
    id = await fileIdea("ada", "CLI withdraw: the old search box idea");
  });

  it("refuses anyone but the idea's owner", async () => {
    expect(await refused("bob", "withdraw-idea", { id }, 403)).toMatchObject({ error: "not_idea_owner" });
  });

  it("withdraws it for its owner, with the evidence", async () => {
    const withdrawn = await ok("ada", "withdraw-idea", { id, evidence: "The new search page replaced it." });
    expect(withdrawn).toMatchObject({ ideaId: id, status: "archived", reason: "withdrawn", evidence: "The new search page replaced it." });
    expect((await ok("bob", "get-idea", { id })).idea).toMatchObject({ status: "archived", archiveReason: "withdrawn" });
  });

  it("can't withdraw an idea that is no longer open", async () => {
    expect(await refused("ada", "withdraw-idea", { id }, 409)).toMatchObject({ error: "idea_not_open" });
  });
});
