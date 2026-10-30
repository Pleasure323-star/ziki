/**
 * The `RateLimit-*` response headers for agent budgets (#646). Kept apart
 * from rate-budget.ts, which tests often mock wholesale, so routes can always
 * add the headers.
 */

/**
 * Which budget a request was charged to: writes change the board, reads
 * only look, and heartbeat is its own small budget for claim-keeping pings
 * (#556).
 */
type BudgetKind = "read" | "write" | "heartbeat";

/**
 * What a charge says about the budget it was taken from (#646). `remaining`
 * and `resetSeconds` come from the store's own check, so reporting them costs
 * no extra read or write; a store or test double that doesn't report them
 * just leaves them out.
 */
export type AgentBudgetQuota = {
  kind?: BudgetKind;
  limit?: number;
  windowSeconds?: number;
  remaining?: number;
  resetSeconds?: number;
};

/**
 * The IETF draft `RateLimit-*` fields for one budget (#646): its limit, what's
 * left and when it resets (seconds from now), the policy (`60;w=60`), and
 * which budget it is, since reads and writes are counted apart. Only the
 * calling agent's own budget is ever described.
 */
export function agentBudgetHeaders(budget: AgentBudgetQuota): Record<string, string> {
  const headers: Record<string, string> = {};
  if (budget.kind) headers["RateLimit-Budget"] = budget.kind;
  if (typeof budget.limit === "number") {
    const limit = String(budget.limit);
    headers["RateLimit-Limit"] = limit;
    if (typeof budget.windowSeconds === "number") headers["RateLimit-Policy"] = `${budget.limit};w=${budget.windowSeconds}`;
  }
  if (typeof budget.remaining === "number") {
    const remaining = String(budget.remaining);
    headers["RateLimit-Remaining"] = remaining;
  }
  if (typeof budget.resetSeconds === "number") {
    // Seconds from now, matching `RateLimit-Reset` and the agent docs.
    const reset = String(budget.resetSeconds);
    headers["RateLimit-Reset"] = reset;
  }
  return headers;
}

/** Adds the budget's `RateLimit-*` headers to a response, in place. */
export function withAgentBudgetHeaders<T extends Response>(response: T, budget: AgentBudgetQuota): T {
  for (const [name, value] of Object.entries(agentBudgetHeaders(budget))) response.headers.set(name, value);
  return response;
}

