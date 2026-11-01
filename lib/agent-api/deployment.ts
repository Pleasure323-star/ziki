import type { Substatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/agents/audit";
import { IssueApiError } from "@/lib/agent-api/errors";
import { publish } from "@/lib/agent-api/events";
import { statusChangedSummary } from "@/lib/activity-log";
import { parseIssueRef } from "@/lib/issue-ref";
import { ENVIRONMENTS, LIVE_SUBSTATUS, moveTo } from "@/lib/issue-substatus";

/**
 * Deployment reports (#substatus). A Live issue's substatus says where its
 * merged work is deployed: On dev (merged into the default branch, where
 * resolving puts it), On staging or On prod. Ziki never checks a deployment
 * itself: an agent checks where the work is running and reports it, and the
 * latest report is where it is. Any agent may report, on any Live issue.
 */
export const deploymentSchema = z
  .object({
    environment: z.enum(ENVIRONMENTS),
    /** What the agent checked: the URL, version or commit it saw deployed. */
    note: z.string().trim().min(1, "Say what you checked: the URL, version or commit you saw deployed.").max(2000),
  })
  .strict();

const NOT_FOUND = "No such issue in this project.";

export async function reportDeployment(
  agent: { agentId: string; ownerId: string; tenantId: string },
  scope: { tenantId: string; projectId: string },
  issueRef: string,
  rawBody: unknown,
): Promise<{ issueId: string; status: "resolved"; substatus: Substatus; previousSubstatus: Substatus; changed: boolean }> {
  const parsed = deploymentSchema.safeParse(rawBody ?? {});
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid deployment report.";
    throw new IssueApiError(400, message, { error: "invalid_request", message });
  }
  const { environment, note } = parsed.data;
  const ref = parseIssueRef(issueRef);
  return prisma.$transaction(async (tx) => {
    const bug = await tx.bug.findFirst({
      where: { ...scope, isDeleted: false, ...(ref.kind === "number" ? { number: ref.number } : { id: ref.id }) },
      select: { id: true, tenantId: true, status: true, substatus: true },
    });
    if (!bug) throw new IssueApiError(404, NOT_FOUND, { error: "not_found", message: NOT_FOUND });
    if (bug.status !== "resolved") {
      const message = "Deployments are reported on Live issues: resolve the merged work first.";
      throw new IssueApiError(409, message, { error: "not_live", message, status: bug.status, substatus: bug.substatus });
    }
    const to = LIVE_SUBSTATUS[environment];
    const changed = to !== bug.substatus;
    if (changed) {
      await tx.bug.update({ where: { id: bug.id }, data: moveTo(to) });
      await tx.bugActivity.create({
        data: {
          bugId: bug.id,
          actorId: agent.ownerId,
          type: "status_changed",
          summary: statusChangedSummary(bug.substatus, to),
          metadata: { field: "status", from: bug.substatus, to, via: "deployment", environment, note },
        },
      });
    }
    const payload = { issueId: bug.id, environment, note, from: bug.substatus, to };
    await audit({ agentId: agent.agentId, tenantId: bug.tenantId }, "issue.deployed", `bug:${bug.id}`, payload, { bugId: bug.id, db: tx });
    if (changed) {
      await publish(tx, { tenantId: bug.tenantId, type: "issue.updated", actorAgentId: agent.agentId, bugId: bug.id, payload: { ...payload, values: moveTo(to) } });
    }
    return { issueId: bug.id, status: "resolved" as const, substatus: to, previousSubstatus: bug.substatus, changed };
  });
}
