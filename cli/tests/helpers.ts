import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { loadDotEnv } from "../env";
import { run } from "../run";

loadDotEnv();

export type Agent = "ada" | "bob" | "cara" | "dana" | "eli";

/** API responses vary per route, so scenarios read them loosely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export type CliResult = { code: number; out: string; err: string; json: Json };

/** Runs `pnpm ziki <args>` in-process: the same parsing, HTTP calls and output as the terminal. */
export async function ziki(...args: string[]): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { out: (text) => out.push(text), err: (text) => err.push(text) });
  const text = out.join("\n");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { code, out: text, err: err.join("\n"), json };
}

/** Runs a command as `agent` and expects it to succeed. */
export async function ok(agent: Agent, command: string, flags: Record<string, string | number | boolean | string[]> = {}): Promise<Json> {
  const result = await ziki(command, ...toArgs(flags), "--as", agent);
  expect(result.code, `${command} as ${agent} failed:\n${result.err}\n${result.out}`).toBe(0);
  return result.json;
}

/** Runs a command as `agent` and expects the API to refuse it with `status`. */
export async function refused(
  agent: Agent,
  command: string,
  flags: Record<string, string | number | boolean | string[]>,
  status: number,
): Promise<Json> {
  const result = await ziki(command, ...toArgs(flags), "--as", agent);
  expect(result.code, `${command} as ${agent} should have been refused:\n${result.out}`).toBe(1);
  expect(result.json?.status, `${command} as ${agent}: ${JSON.stringify(result.json?.body)}`).toBe(status);
  return result.json.body;
}

function toArgs(flags: Record<string, string | number | boolean | string[]>): string[] {
  return Object.entries(flags).flatMap(([key, value]) => [
    `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
    Array.isArray(value) ? value.join(",") : String(value),
  ]);
}

let counter = 0;
/** A title unique to this run, so scenarios never trip over each other's issues. */
export function unique(label: string): string {
  return `${label} ${Date.now().toString(36)}${(counter++).toString(36)}`;
}

/** Files a fresh report as `agent`, which is always an idea, and returns the idea's id. */
export async function fileIdea(agent: Agent, label: string): Promise<string> {
  // Scenario titles look alike on purpose, so skip the similar-title check (tested on its own).
  const created = await ok(agent, "create-idea", {
    title: unique(label),
    description: "Steps: open the page and press Save. Expected: it saves. Actual: nothing happens.",
    idempotencyKey: randomUUID(),
    acknowledgeSimilar: true,
  });
  return created.idea.id as string;
}

/**
 * Converts an idea, which creates the issue: each of `givers` says it is a
 * good idea (the default threshold is 3 net votes), then dana, the manager
 * agent, converts it. Returns the new issue's id.
 */
export async function toIssue(ideaId: string, givers: [Agent, Agent, Agent]): Promise<string> {
  for (const agent of givers) {
    await ok(agent, "give-idea-verdict", { id: ideaId, opinion: "good", summary: "Worth doing.", description: `${agent} thinks this is worth doing.` });
  }
  const converted = await ok("dana", "convert-idea", { id: ideaId });
  expect(converted.ideaId).toBe(ideaId);
  return converted.issueId as string;
}

/** Files a report as `agent` and converts it, returning the issue's id (not yet confirmed). */
export async function fileIssue(agent: Agent, label: string, givers: [Agent, Agent, Agent]): Promise<string> {
  return toIssue(await fileIdea(agent, label), givers);
}

/** The sandbox agent Ziki offered the issue to, from each agent's work feed, if any. */
export async function offeredTo(id: string): Promise<{ agent: Agent; offerId: string } | null> {
  for (const agent of ["ada", "bob", "cara", "dana", "eli"] as const) {
    const feed = await ok(agent, "work");
    const offer = (feed.items as { kind: string; key: string; issue?: { id: string } }[]).find((item) => item.kind === "offer" && item.issue?.id === id);
    if (offer) return { agent, offerId: offer.key.replace(/^offer:/, "") };
  }
  return null;
}

/** The work feed item of `kind` for issue `id` in an agent's feed, if any. */
export async function feedItem(agent: Agent, kind: string, id: string): Promise<{ kind: string; actions?: { name: string }[] } | undefined> {
  const feed = await ok(agent, "work");
  return (feed.items as { kind: string; issue?: { id: string }; actions?: { name: string }[] }[]).find((item) => item.kind === kind && item.issue?.id === id);
}

/** Confirms an issue the way the workflow needs: two independent confirmation entries (#issue-confirmations). */
export async function confirm(id: string, confirmers: [Agent, Agent]): Promise<void> {
  const [first, second] = confirmers;
  await ok(first, "confirm-issue", { id, verdict: "confirm", summary: "Reproduced it.", description: "Followed the steps; it fails as reported and no other issue covers it.", severity: "high" });
  const last = await ok(second, "confirm-issue", { id, verdict: "confirm", summary: "Reproduced it too.", description: "Same result on a second machine; not a duplicate." });
  expect(last.confirmed).toBe(true);
}
