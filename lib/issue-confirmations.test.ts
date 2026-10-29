import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@/lib/workflow", () => ({ workflowFor: vi.fn(async () => ({ confirmationsNeeded: 2 })) }));

import { openIssueConfirmations } from "./issue-stage";

type Validation = { id: string; kind: "real" | "duplicate"; agentId: string; owner: string; createdAt?: Date };

/** A fake Prisma client holding one issue reported by ada, in `status` (Requires confirmation by default). */
function db(validations: Validation[], options: { revisedAt?: Date; undone?: string[]; status?: string } = {}) {
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
    issueValidation: {
      findMany: vi.fn(async () => validations.map((v) => ({
        id: v.id, bugId: "b1", kind: v.kind, createdAt: v.createdAt ?? new Date("2026-10-05"), agentId: v.agentId, onBehalfOfUserId: v.owner, agent: { ownerUserId: v.owner },
      }))),
    },
    agentAuditEvent: { findMany: vi.fn(async () => (options.undone ?? []).map((id) => ({ bugId: "b1", payload: { validationId: id } }))) },
  } as unknown as PrismaClient;
}

const accept = (id: string, owner: string): Validation => ({ id, kind: "real", agentId: `agent-${owner}`, owner });
const clear = (id: string, owner: string): Validation => ({ id, kind: "duplicate", agentId: `agent-${owner}`, owner });

describe("openIssueConfirmations (#714): one rule for confirmed", () => {
  it("counts toward confirmation: two independent accepts AND a duplicate clearance", async () => {
    const accepted = await openIssueConfirmations(db([accept("v1", "bob"), accept("v2", "cara")]), {});
    expect(accepted.get("b1")).toEqual({ stage: "confirming", accepts: 2, needed: 2, triageCleared: false });

    // Confirmed, the issue is Open, and the stage follows the status (#requires-confirmation).
    const confirmed = await openIssueConfirmations(db([accept("v1", "bob"), accept("v2", "cara"), clear("v3", "eli")], { status: "open" }), {});
    expect(confirmed.get("b1")).toEqual({ stage: "ready", accepts: 2, needed: 2, triageCleared: true });
  });

  it("does not count the reporter's own reviews or clearance", async () => {
    const own = await openIssueConfirmations(db([accept("v1", "ada"), accept("v2", "bob"), clear("v3", "ada")]), {});
    expect(own.get("b1")).toMatchObject({ stage: "confirming", accepts: 1, triageCleared: false });
  });

  it("drops undone reviews and ones given before the latest edit", async () => {
    const result = await openIssueConfirmations(
      db([accept("v1", "bob"), { ...accept("v2", "cara"), createdAt: new Date("2026-10-02") }, clear("v3", "eli")], { revisedAt: new Date("2026-10-03"), undone: ["v3"] }),
      {},
    );
    expect(result.get("b1")).toMatchObject({ stage: "confirming", accepts: 1, triageCleared: false });
  });

});
