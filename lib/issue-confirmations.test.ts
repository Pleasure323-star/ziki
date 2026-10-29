import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@/lib/workflow", () => ({ workflowFor: vi.fn(async () => ({ confirmationsNeeded: 2 })) }));

import { confirmedIssueIds, openIssueConfirmations, readConfirmations } from "./issue-stage";

type Entry = {
  id: string;
  verdict: "confirm" | "reject";
  owner: string;
  agent?: boolean;
  duplicateOfId?: string | null;
  updatedAt?: Date;
};

/** A fake Prisma client holding one issue reported by ada, in `status` (Requires confirmation by default). */
function db(entries: Entry[], options: { revisedAt?: Date; status?: string } = {}) {
  return {
    bug: {
      findMany: vi.fn(async () => [{
        id: "b1",
        projectId: "p1",
        status: options.status ?? "requires_confirmation",
        beneficiaryUserId: "ada",
        reporterId: "ada",
        createdByAgentId: "agent-ada",
        createdByAgent: { ownerUserId: "ada" },
      }]),
    },
    bugRevision: { findMany: vi.fn(async () => (options.revisedAt ? [{ bugId: "b1", editedAt: options.revisedAt }] : [])) },
    issueConfirmation: {
      // The query asks for confirm and reject entries that were not undone.
      findMany: vi.fn(async () => entries.map((e) => ({
        id: e.id,
        bugId: "b1",
        verdict: e.verdict,
        duplicateOfId: e.duplicateOfId ?? null,
        updatedAt: e.updatedAt ?? new Date("2026-10-05"),
        agentId: e.agent === false ? null : `agent-${e.owner}`,
        onBehalfOfUserId: e.owner,
        agent: e.agent === false ? null : { ownerUserId: e.owner },
      }))),
    },
  } as unknown as PrismaClient;
}

const confirm = (id: string, owner: string, extra: Partial<Entry> = {}): Entry => ({ id, verdict: "confirm", owner, ...extra });
const reject = (id: string, owner: string, extra: Partial<Entry> = {}): Entry => ({ id, verdict: "reject", owner, ...extra });

describe("readConfirmations (#714, #issue-confirmations): one rule for confirmed", () => {
  it("confirms on two independent confirms; there is no separate duplicate clearance", async () => {
    const one = await openIssueConfirmations(db([confirm("c1", "bob")]), {});
    expect(one.get("b1")).toEqual({ stage: "confirming", accepts: 1, rejects: 0, needed: 2 });

    const read = await readConfirmations(db([confirm("c1", "bob"), confirm("c2", "cara", { agent: false })]), {});
    expect(read.get("b1")).toMatchObject({ confirmed: true, accepts: 2, confirmers: ["bob", "cara"], duplicate: false });
    expect(await confirmedIssueIds(db([confirm("c1", "bob"), confirm("c2", "cara")]), {})).toEqual(new Set(["b1"]));
  });

  it("does not count the reporter's own entry, as an agent's owner or as a person", async () => {
    const own = await readConfirmations(db([confirm("c1", "ada"), confirm("c2", "ada", { agent: false }), confirm("c3", "bob")]), {});
    expect(own.get("b1")).toMatchObject({ confirmed: false, accepts: 1 });
  });

  it("drops entries given before the latest edit", async () => {
    const result = await readConfirmations(
      db([confirm("c1", "bob"), confirm("c2", "cara", { updatedAt: new Date("2026-10-02") })], { revisedAt: new Date("2026-10-03") }),
      {},
    );
    expect(result.get("b1")).toMatchObject({ confirmed: false, accepts: 1 });
  });

  it("counts rejects apart, and a reject naming another issue marks a duplicate", async () => {
    const result = await readConfirmations(db([confirm("c1", "bob"), reject("r1", "cara", { duplicateOfId: "b0" }), reject("r2", "dan")]), {});
    expect(result.get("b1")).toMatchObject({ confirmed: false, accepts: 1, rejects: 2, duplicate: true });
  });

  it("reads nothing from a client without the confirmation table", async () => {
    expect((await readConfirmations({ bug: { findMany: vi.fn() } } as unknown as PrismaClient, {})).size).toBe(0);
  });
});
