import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { parseEventFilters, parseEventCursor, eventCursorError, scopeEventFilters, type EventFilters } from "@/lib/agent-api/events";
import { eventStreamBus, type StreamEvent } from "@/lib/events/stream-bus";
import { AgentProjectError, agentErrorResponse, requireAgent, type AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { consumeAgentBudget, agentBudgetExceededResponse } from "@/lib/agents/rate-budget";
import { withAgentBudgetHeaders } from "@/lib/agents/rate-budget-headers";
import { audit } from "@/lib/agents/audit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/v1/events/stream?types=&projectId=&bugId=&after=&afterId=
 *
 * Server-Sent Events stream endpoint for real-time agent events (#615).
 * Subscribes to in-memory event bus and sends events as they occur.
 *
 * Streaming headers:
 * - Content-Type: text/event-stream
 * - Cache-Control: no-cache, no-transform
 * - Connection: keep-alive
 *
 * Heartbeat: sends periodic ping comments `: ping\n\n` to keep connections alive.
 * Event format: `id: <id>\nevent: <type>\ndata: <json>\n\n`
 *
 * Client disconnection is handled via request.signal.abort to clean up subscriptions.
 *
 * Query parameters:
 * - `types`     — comma list of event types or prefixes (`claim.*`)
 * - `projectId` — filter by project
 * - `bugId`     — filter by issue
 * - `after`     — resume from cursor (optional, for replaying missed events)
 * - `afterId`   — tie-breaker when `after` is timestamp
 *
 * Requires authenticated agent key. Respects tenant scoping and project restrictions.
 */
export async function GET(request: NextRequest) {
  let agent: AgentContext;
  try {
    agent = await requireAgent(request);
    requireLevel(agent, "working");
  } catch (error) {
    return agentErrorResponse(error);
  }

  const budget = await consumeAgentBudget({ id: agent.agentId, burst: agent.burst }, "read");
  if (!budget.allowed) {
    const res = agentBudgetExceededResponse(budget.retryAfterSeconds, budget);
    return res;
  }

  const params = request.nextUrl.searchParams;

  const parsedFilters = parseEventFilters(params);
  if ("error" in parsedFilters) {
    return NextResponse.json(parsedFilters, { status: 400 });
  }

  // #607: a project-scoped key must not replay or stream another project's
  // events. Apply the same scope rules as GET /api/v1/events.
  let filters: EventFilters;
  try {
    const scoped = await scopeEventFilters(agent, parsedFilters);
    if ("status" in scoped) {
      return NextResponse.json({ error: scoped.error }, { status: scoped.status });
    }
    filters = scoped.filters;
  } catch (error) {
    if (error instanceof AgentProjectError) return agentErrorResponse(error);
    logger.error("[agent-api] event stream scope failed", {
      tenantId: agent.tenantId,
      agentId: agent.agentId,
      error,
    });
    return NextResponse.json({ error: "Event feed unavailable." }, { status: 503 });
  }

  const cursorResult = parseEventCursor(params);
  if (cursorResult === "invalid") {
    return NextResponse.json({ error: eventCursorError(params) }, { status: 400 });
  }

  const encoder = new TextEncoder();
  let heartbeatInterval: NodeJS.Timeout | null = null;
  let subscriptionId: string | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const connectMsg = `event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`;
      controller.enqueue(encoder.encode(connectMsg));

      heartbeatInterval = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch (err) {
          cleanup();
          controller.error(err);
        }
      }, 15000);

      const deliveredIds = new Set<string>();
      let replaying = Boolean(cursorResult);
      const liveBuffer: StreamEvent[] = [];

      function sendEvent(event: StreamEvent): boolean {
        if (closed) return false;
        if (deliveredIds.has(event.id)) return true;
        deliveredIds.add(event.id);
        if (deliveredIds.size > 5000) {
          const first = deliveredIds.values().next().value;
          if (first) deliveredIds.delete(first);
        }
        try {
          const sseLine = formatSseEvent(event);
          controller.enqueue(encoder.encode(sseLine));
          return true;
        } catch (err) {
          cleanup();
          try { controller.error(err); } catch {}
          return false;
        }
      }

      subscriptionId = eventStreamBus.subscribe(agent, filters, (event: StreamEvent) => {
        if (closed) return;
        if (replaying) {
          liveBuffer.push(event);
        } else {
          sendEvent(event);
        }
      });

      if (cursorResult) {
        drainHistoricalEvents(agent, cursorResult, filters, (event) => {
          return sendEvent({
            id: event.id,
            type: event.type,
            payload: event.payload,
            actorAgentId: event.actorAgentId,
            bugId: event.bugId,
            tenantId: agent.tenantId,
            createdAt: event.createdAt,
          });
        })
          .catch((error) => {
            // #611: a failed replay must not leave the client believing it has the whole
            // backlog. Log it and send an error event; live events still flow after it.
            logger.error("[agent-api] event stream replay failed", {
              tenantId: agent.tenantId,
              agentId: agent.agentId,
            }, error);
            if (closed) return;
            try {
              controller.enqueue(
                encoder.encode(
                  `event: error\ndata: ${JSON.stringify({ error: "Could not replay missed events. Reconnect with the same cursor to retry." })}\n\n`,
                ),
              );
            } catch {}
          })
          .finally(() => {
            if (closed) return;
            replaying = false;
            for (const live of liveBuffer) {
              if (closed) break;
              sendEvent(live);
            }
            liveBuffer.length = 0;
          });
      }

      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });

  function cleanup() {
    closed = true;
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (subscriptionId) {
      eventStreamBus.unsubscribe(subscriptionId);
      subscriptionId = null;
    }
  }

  const payload = { status: 200, request: true as const };
  try {
    await audit(agent, "events.stream", null, payload);
  } catch (error) {
    logger.error("[agent-api] request audit failed", {
      tenantId: agent.tenantId,
      agentId: agent.agentId,
      action: "events.stream",
      target: null,
      payload,
    }, error);
  }

  const response = new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
  response.headers.set("Cache-Control", "no-cache, no-transform");
  return withAgentBudgetHeaders(response, budget) as unknown as NextResponse;
}

/**
 * Format an event as SSE frame.
 * @param event - Event to format
 * @returns Formatted SSE string: `id: <id>\nevent: <type>\ndata: <json>\n\n`
 */
function formatSseEvent(event: StreamEvent): string {
  const data = JSON.stringify({
    id: event.id,
    type: event.type,
    payload: event.payload,
    actorAgentId: event.actorAgentId,
    bugId: event.bugId,
    createdAt: event.createdAt instanceof Date ? event.createdAt.toISOString() : event.createdAt,
  });
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${data}\n\n`;
}

/**
 * Drain historical events from the database after the cursor across all pages (#478).
 * @param agent - Agent context
 * @param initialCursor - Event cursor to start after
 * @param filters - Event filters
 * @param onEvent - Callback for each event; returns false if consumer closed
 */
async function drainHistoricalEvents(
  agent: { tenantId: string },
  initialCursor: import("@/lib/agent-api/events").EventCursor,
  filters: import("@/lib/agent-api/events").EventFilters,
  onEvent: (event: import("@/lib/agent-api/events").AgentEventRow) => boolean,
): Promise<void> {
  const { listEvents } = await import("@/lib/agent-api/events");
  let cursor: import("@/lib/agent-api/events").EventCursor | null = initialCursor;

  while (cursor) {
    const page = await listEvents(agent, cursor, filters);
    if (!page || page.length === 0) break;

    for (const event of page) {
      const ok = onEvent(event);
      if (!ok) return;
    }

    if (page.length < 101) {
      break;
    }

    const last = page[page.length - 1];
    cursor = { txid: last.txid, id: last.id };
  }
}

const apiMethodNotAllowed = createMethodNotAllowed(["GET", "HEAD", "OPTIONS"]);
const apiOptions = createOptions(["GET", "HEAD", "OPTIONS"]);
export const POST = apiMethodNotAllowed;
export const PUT = apiMethodNotAllowed;
export const PATCH = apiMethodNotAllowed;
export const DELETE = apiMethodNotAllowed;
export const OPTIONS = apiOptions;
