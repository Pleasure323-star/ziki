import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { absoluteUrl } from "@/lib/site-url";
import { WATCH_WORK_MESSAGE } from "@/lib/agents/pairing-link";
import { NextResponse, type NextRequest } from "next/server";
import { agentErrorResponse, requireAgent } from "@/lib/agents/require-agent";
import { agentBudgetExceededResponse, consumeAgentBudget } from "@/lib/agents/rate-budget";
import { withAgentBudgetHeaders } from "@/lib/agents/rate-budget-headers";
import { listAgentProjectSummaries } from "@/lib/agent-api/projects";
import { readAgentInstructions } from "@/lib/agent-messages";

/**
 * GET /api/v1/agents/me — who this key belongs to (#427). Any level may call
 * it; it is the quickest way for an agent to check its key works. It also
 * lists the tenant's projects (#607) so an agent can pick the `projectId`
 * every issue route needs, and the owner's standing `instructions` (#605).
 */
export async function GET(req: NextRequest) {
  try {
    const agent = await requireAgent(req);
    // A read like the other list/get routes, so every authenticated agent
    // response carries its own quota headers (#596).
    const budget = await consumeAgentBudget(
      { id: agent.agentId, burst: agent.burst, burstUntil: agent.burstUntil ?? null },
      "read",
    );
    if (!budget.allowed) return agentBudgetExceededResponse(budget.retryAfterSeconds, budget);
    const [projects, instructions] = await Promise.all([
      listAgentProjectSummaries(agent.tenantId),
      readAgentInstructions(agent.agentId),
    ]);
    return withAgentBudgetHeaders(
      NextResponse.json({
        id: agent.agentId,
        name: agent.name,
        owner_id: agent.ownerId,
        tenant_id: agent.tenantId,
        level: agent.level,
        project_id: agent.projectId ?? null,
        project_slug: agent.projectSlug ?? null,
        // #work-feed: the one URL to watch. A key for every project finds each one's under `projects`.
        work_url: agent.projectSlug ? absoluteUrl(`/${agent.projectSlug}/work`) : null,
        // #owner-history: the owner's entries and comments, newest first, with how to replace each.
        history_url: absoluteUrl("/api/v1/agents/me/history"),
        next_step: WATCH_WORK_MESSAGE,
        projects,
        instructions,
      }),
      budget,
    );
  } catch (error) {
    return agentErrorResponse(error);
  }
}

const apiMethodNotAllowed = createMethodNotAllowed(["GET", "HEAD", "OPTIONS"]);
const apiOptions = createOptions(["GET", "HEAD", "OPTIONS"]);
export const POST = apiMethodNotAllowed;
export const PUT = apiMethodNotAllowed;
export const PATCH = apiMethodNotAllowed;
export const DELETE = apiMethodNotAllowed;
export const OPTIONS = apiOptions;
