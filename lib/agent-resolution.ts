/**
 * Ziki #515: an agent resolved this issue because its fix was merged. The
 * status change records who did it, with which pull request, and the status
 * to go back to, so a person can reopen it in one click.
 */

/** `via` on the status change an agent resolve writes. */
export const AGENT_RESOLVE_VIA = "agent_resolve";

export type AgentResolution = { agentName: string; pullRequestUrl: string; previousStatus: "open" | "in_progress" };

/** The agent resolve recorded in a status change's metadata, or null for any other change. */
export function readAgentResolution(metadata: unknown): AgentResolution | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;
  if (m.via !== AGENT_RESOLVE_VIA || !(m.to === "resolved" || m.to === "on_dev" || m.to === "on_staging" || m.to === "on_prod")) return null;
  if (typeof m.agentName !== "string" || typeof m.pullRequestUrl !== "string") return null;
  return {
    agentName: m.agentName,
    pullRequestUrl: m.pullRequestUrl,
    // Only open work can be agent-resolved; anything else reopens as open.
    previousStatus: m.from === "in_progress" ? "in_progress" : "open",
  };
}
