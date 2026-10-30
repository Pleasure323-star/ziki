import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { timingSafeEqual, createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { sweepStaleClaims } from "@/lib/agent-api/availability";
import { isAgentPlatformEnabled } from "@/lib/feature-flags";
import { agentPlatformDisabledResponse } from "@/lib/agents/platform-gate";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/v1/claims/dispatch — scheduler only; agent keys are rejected (#524).
 *
 * Releases active claims whose agent has not heartbeated for 15 minutes
 * (`lib/agent-api/availability.ts` `sweepStaleClaims`), publishes a
 * `claim.released` event atomically with each release. A reopened issue goes
 * back to Open for bids. Returns `{ released }`. Schedule it like the webhook
 * dispatcher; both run from an external cron.
 */
export async function POST(request: NextRequest) {
  if (!isAgentPlatformEnabled()) return agentPlatformDisabledResponse();
  const secret = process.env.CLAIM_DISPATCH_SECRET;
  const headers = { "Cache-Control": "no-store" };
  if (!secret) return NextResponse.json({ error: "Claim sweep is not configured." }, { status: 503, headers });
  const hash = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(hash(request.headers.get("authorization") ?? ""), hash(`Bearer ${secret}`))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers });
  }
  try { return NextResponse.json(await sweepStaleClaims(), { headers }); }
  catch { return NextResponse.json({ error: "Claim sweep unavailable; the next scheduled run will retry." }, { status: 503, headers }); }
}

const apiMethodNotAllowed = createMethodNotAllowed(["POST", "OPTIONS"]);
const apiOptions = createOptions(["POST", "OPTIONS"]);
export const GET = apiMethodNotAllowed;
export const PUT = apiMethodNotAllowed;
export const PATCH = apiMethodNotAllowed;
export const DELETE = apiMethodNotAllowed;
export const HEAD = apiMethodNotAllowed;
export const OPTIONS = apiOptions;
