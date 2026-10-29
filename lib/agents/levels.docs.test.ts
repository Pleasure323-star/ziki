import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { AgentLevel } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { AGENT_LEVELS } from "./levels";

/**
 * The Agent Levels table in the agent docs (served as /llms.txt) must agree
 * with each route's own `**Level:**` line (Ziki #464). Every route sits in the
 * row of the lowest level that can call it; this fails when a route is added,
 * moved or dropped on one side only.
 */
const doc = readFileSync(path.resolve(__dirname, "../../docs/ziki-for-agents.md"), "utf8");

const ROUTE = /^(GET|POST|PUT|PATCH|DELETE) \/api\/v1\/\S+$/;

/** Routes listed in each row of the Agent Levels table. */
function tableRoutes(): Map<AgentLevel, Set<string>> {
  const rows = new Map<AgentLevel, Set<string>>();
  for (const level of AGENT_LEVELS) {
    const row = new RegExp(`^\\|\\s*\`${level}\`\\s*\\|[^|]*\\|(.*)\\|\\s*$`, "m").exec(doc);
    if (!row) throw new Error(`No "${level}" row in the Agent Levels table`);
    const routes = [...row[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((t) => ROUTE.test(t));
    rows.set(level, new Set(routes));
  }
  return rows;
}

/** The level each route's section states, from its first backticked level. */
function sectionLevels(): Map<string, AgentLevel> {
  const levels = new Map<string, AgentLevel>();
  let heading: string | null = null;
  for (const line of doc.split("\n")) {
    const h = /^### `?((?:GET|POST|PUT|PATCH|DELETE) \/api\/v1\/\S+?)`?\s*$/.exec(line);
    if (h) {
      heading = h[1];
      continue;
    }
    if (line.startsWith("### ") || line.startsWith("## ")) heading = null;
    const level = /^\*\*Level:\*\* `(\w+)`/.exec(line);
    if (heading && level && (AGENT_LEVELS as readonly string[]).includes(level[1])) {
      levels.set(heading, level[1] as AgentLevel);
      heading = null;
    }
  }
  return levels;
}

const repo = path.resolve(__dirname, "../..");
const apiRoot = path.join(repo, "app/api/v1");

/** `app/api/v1/issues/[id]/route.ts` → `/api/v1/issues/{id}`. */
function routePath(file: string): string {
  const rel = path.relative(apiRoot, path.dirname(file)).split(path.sep)
    .map((part) => part.replace(/^\[(\w+)\]$/, "{$1}")).join("/");
  return rel ? `/api/v1/${rel}` : "/api/v1";
}

function routeFiles(dir = apiRoot): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === "route.ts" ? [full] : [];
  });
}

/** The level each handler passes to `agentIssueRequest` or `requireLevel`, keyed `METHOD /api/v1/...`. */
function codeLevels(): Map<string, string> {
  const levels = new Map<string, string>();
  for (const file of routeFiles()) {
    const source = readFileSync(file, "utf8");
    const handlers = [...source.matchAll(/export\s+(?:async\s+function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)];
    handlers.forEach((handler, i) => {
      const body = source.slice(handler.index, handlers[i + 1]?.index ?? source.length);
      const level = /agentIssueRequest\(\s*[^,]+,\s*[^,]+,\s*"(\w+)"/.exec(body) ?? /requireLevel\(\s*\w+,\s*"(\w+)"\)/.exec(body);
      // `"read"` is a working-agent route charged to the read budget.
      if (level) levels.set(`${handler[1]} ${routePath(file)}`, level[1] === "read" ? "working" : level[1]);
    });
  }
  return levels;
}

/**
 * Routes whose handler states no level (or a lower one) and enforces the real
 * one later, with the file and check that does it.
 */
const ENFORCED_ELSEWHERE: Record<string, { file: string; check: string }> = {
  "POST /api/v1/issues/{id}/comments": { file: "app/api/v1/issues/[id]/comments/route.ts", check: '"comments.create", "working"' },
  "POST /api/v1/issues/{id}/vote": { file: "app/api/v1/issues/[id]/vote/route.ts", check: '"issues.vote", "working"' },
  "DELETE /api/v1/issues/{id}/vote": { file: "app/api/v1/issues/[id]/vote/route.ts", check: '"issues.vote_remove", "working"' },
  "GET /api/v1/dispatcher/metrics": { file: "app/api/v1/dispatcher/metrics/route.ts", check: 'hasLevel(agent.level, "manager")' },
  "POST /api/v1/issues/{id}/assign": { file: "app/api/v1/issues/[id]/assign/route.ts", check: '"issues.assign", "manager"' },
  "POST /api/v1/issues/{id}/merge": { file: "lib/agent-api/merge.ts", check: 'hasLevel(agent.level, "manager")' },
  "POST /api/v1/issues/{id}/admin-merge": { file: "lib/agent-api/merge.ts", check: 'hasLevel(agent.level, "merger")' },
  "POST /api/v1/issues/{id}/test-results": { file: "lib/agent-api/test-verdict.ts", check: 'hasLevel(agent.level, "working")' },
  // Any valid agent key: every class may confirm, reject or stay neutral.
  "POST /api/v1/issues/{id}/confirmations": { file: "app/api/v1/issues/[id]/confirmations/route.ts", check: '"issues.confirm", "working"' },
};

describe("llms.txt Agent Levels table matches the per-route Level lines (#464)", () => {
  const rows = tableRoutes();
  const sections = sectionLevels();

  it("finds the documented routes", () => {
    expect(sections.size).toBeGreaterThan(50);
  });

  it("lists every route under the level its section states", () => {
    const missing = [...sections]
      .filter(([route, level]) => !rows.get(level)!.has(route))
      .map(([route, level]) => `${route} (${level})`);
    expect(missing).toEqual([]);
  });

  it("lists no route that its section puts at a different level", () => {
    const misplaced: string[] = [];
    for (const [level, routes] of rows) {
      for (const route of routes) {
        const stated = sections.get(route);
        if (stated !== level) misplaced.push(`${route}: table ${level}, section ${stated ?? "none"}`);
      }
    }
    expect(misplaced).toEqual([]);
  });

  it("states the level each route's handler enforces", () => {
    const code = codeLevels();
    const wrong: string[] = [];
    for (const [route, level] of sections) {
      const elsewhere = ENFORCED_ELSEWHERE[route];
      if (elsewhere) {
        const source = readFileSync(path.join(repo, elsewhere.file), "utf8");
        if (!source.includes(elsewhere.check)) wrong.push(`${route}: ${elsewhere.file} no longer has ${elsewhere.check}`);
        continue;
      }
      const enforced = code.get(route);
      if (enforced !== level) wrong.push(`${route}: section ${level}, handler ${enforced ?? "none"}`);
    }
    expect(wrong).toEqual([]);
  });

  it("gives the inbox and the event stream a Level line", () => {
    for (const route of ["GET /api/v1/inbox", "POST /api/v1/inbox/read", "GET /api/v1/events/stream"]) {
      expect(sections.get(route)).toBe("working");
    }
  });
});
