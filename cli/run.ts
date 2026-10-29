import { buildRequest, type ToolDef } from "../packages/mcp-server/src/tools";
import { ZikiApiError, ZikiClient, type RequestSpec } from "../packages/mcp-server/src/client";
import { CLI_TOOLS, commandName, findTool, toolPath, type CliTool } from "./catalog";
import { CliUsageError, describeType, parseArgs, toKebab, toolInput } from "./args";
import { CliEnvironmentError, localServerUrl } from "./env";
import { readKeyring, resolveAgent, writeKeyring, type KeyringAgent } from "./keyring";

/**
 * `pnpm ziki`: the Ziki agent API from a terminal, against a local server.
 *
 * Exit codes: 0 done, 1 the API refused or failed, 2 bad usage, 3 the local
 * server or database isn't there (or isn't local).
 */
export type CliIo = { out: (text: string) => void; err: (text: string) => void };

export const EXIT = { ok: 0, api: 1, usage: 2, environment: 3 } as const;

/** Flags every command accepts; never sent to the API. */
const GLOBAL_FLAGS = new Set(["as", "server", "help"]);

const HELP = `ziki: the Ziki agent API from your terminal, against a LOCAL server only.

Setup (once, with the local server running, e.g. \`pnpm dev\`):
  pnpm ziki doctor               Check the local server, database and keyring
  pnpm ziki setup [--reset]      Create the local CLI sandbox and its agents' keys
  pnpm ziki agents               List the sandbox agents (ada, bob, cara = working; dana = manager; eli = merger)
  pnpm ziki use <agent>          Act as <agent> by default

Calling the API:
  pnpm ziki commands [--search <text>]   Every API command, with its agent class
  pnpm ziki help <command>               A command's flags
  pnpm ziki <command> [--flag value ...] [--as <agent>]
  pnpm ziki request <METHOD> <path> [--body <json>] [--as <agent>]   Any /api/v1 route

Examples:
  pnpm ziki create-idea --title "Save fails" --description "Steps: ..." --as ada
  pnpm ziki confirm-issue --id <issueId> --verdict confirm --summary "Reproduced it." --description "Steps ..." --as bob
  pnpm ziki work --as dana

Global flags: --as <agent>, --server <local server> (default http://localhost:3001, or ZIKI_CLI_URL).
Output is JSON on stdout. Exit codes: 0 ok, 1 API error, 2 usage, 3 environment.`;

function usage(message: string): never {
  throw new CliUsageError(message);
}

function single(flags: Record<string, string[]>, name: string): string | undefined {
  const values = flags[name];
  return values ? values[values.length - 1] : undefined;
}

function printJson(io: CliIo, value: unknown): void {
  io.out(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function toolHelp(tool: CliTool): string {
  const lines = [`${commandName(tool)} — ${tool.summary}`, "", `  ${tool.method} ${toolPath(tool)}   (needs a ${tool.level} agent or higher)`, ""];
  const fields = Object.entries(tool.input);
  if (!fields.length) lines.push("  No flags.");
  for (const [key, schema] of fields) {
    const s = schema as { description?: string; isOptional?: () => boolean };
    const optional = typeof s.isOptional === "function" ? s.isOptional() : false;
    lines.push(`  --${toKebab(key)} <${describeType(schema as never)}>${optional ? "" : "  (required)"}`);
    if (s.description) lines.push(`      ${s.description}`);
  }
  return lines.join("\n");
}

function clientFor(agent: KeyringAgent, serverUrl: string): ZikiClient {
  return new ZikiClient({ url: serverUrl, apiKey: agent.key, projectId: agent.projectId });
}

async function callApi(io: CliIo, client: ZikiClient, spec: RequestSpec, onSuccess?: (data: unknown) => void): Promise<number> {
  try {
    const data = await client.request(spec);
    onSuccess?.(data);
    printJson(io, data);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof ZikiApiError) {
      io.err(`Error ${error.message}`);
      printJson(io, { status: error.status, body: error.body });
      return EXIT.api;
    }
    if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
      throw new CliEnvironmentError(`Can't reach the local server at ${client.config.url}. Start it with \`pnpm dev\`.`);
    }
    throw error;
  }
}

async function doctor(io: CliIo, serverUrl: string): Promise<number> {
  const { checkDatabase, disconnect } = await import("./setup");
  const report: Record<string, unknown> = { serverUrl };
  try {
    await checkDatabase();
    report.database = "ok (local)";
  } finally {
    await disconnect();
  }
  let health: Response;
  try {
    health = await fetch(new URL("/api/health", serverUrl));
  } catch {
    throw new CliEnvironmentError(`Can't reach the local server at ${serverUrl}. Start it with \`pnpm dev\`.`);
  }
  report.server = health.ok ? await health.json() : `HTTP ${health.status}`;
  const keyring = readKeyring();
  const names = Object.keys(keyring.agents);
  report.keyring = names.length ? { current: keyring.current, agents: names } : "empty: run `pnpm ziki setup`";
  if (keyring.current && keyring.agents[keyring.current]) {
    try {
      const me = (await clientFor(keyring.agents[keyring.current], serverUrl).request({ method: "GET", path: "/agents/me" })) as {
        agent?: { name?: string; level?: string };
      };
      report.signedInAs = me.agent ?? me;
    } catch (error) {
      report.signedInAs = error instanceof ZikiApiError ? `refused (${error.message}); run \`pnpm ziki setup\`` : String(error);
    }
  }
  printJson(io, report);
  return health.ok ? EXIT.ok : EXIT.environment;
}

export async function run(argv: readonly string[], io: CliIo = { out: console.log, err: console.error }): Promise<number> {
  try {
    const { positional, flags } = parseArgs(argv);
    const [command, ...rest] = positional;
    if (!command || command === "help" && !rest.length || flags.help && !command) {
      io.out(HELP);
      return EXIT.ok;
    }
    const serverUrl = localServerUrl(single(flags, "server"));

    switch (command) {
      case "help": {
        const tool = findTool(rest[0]);
        if (!tool) usage(`Unknown command "${rest[0]}". Run \`pnpm ziki commands\`.`);
        io.out(toolHelp(tool));
        return EXIT.ok;
      }
      case "commands": {
        const search = single(flags, "search")?.toLowerCase();
        const rows = CLI_TOOLS.filter((tool) => !search || `${commandName(tool)} ${tool.summary}`.toLowerCase().includes(search)).map(
          (tool) => `${commandName(tool).padEnd(32)} ${tool.level.padEnd(8)} ${tool.method.padEnd(6)} ${toolPath(tool)}`,
        );
        io.out(rows.join("\n"));
        return EXIT.ok;
      }
      case "doctor":
        return await doctor(io, serverUrl);
      case "setup": {
        const { setupSandbox, disconnect } = await import("./setup");
        try {
          const { sandbox, ...keyring } = await setupSandbox({ reset: single(flags, "reset") === "true", serverUrl });
          writeKeyring(keyring);
          printJson(io, {
            sandbox,
            current: keyring.current,
            agents: Object.values(keyring.agents).map(({ name, level, ownerEmail, agentId }) => ({ name, level, owner: ownerEmail, agentId })),
          });
          return EXIT.ok;
        } finally {
          await disconnect();
        }
      }
      case "agents": {
        const keyring = readKeyring();
        printJson(io, {
          current: keyring.current,
          agents: Object.values(keyring.agents).map(({ name, level, ownerEmail, agentId, projectId }) => ({ name, level, owner: ownerEmail, agentId, projectId })),
        });
        return EXIT.ok;
      }
      case "use": {
        const keyring = readKeyring();
        resolveAgent(keyring, rest[0] ?? usage("Name the agent: `pnpm ziki use <agent>`."));
        writeKeyring({ ...keyring, current: rest[0] });
        printJson(io, { current: rest[0] });
        return EXIT.ok;
      }
      case "request": {
        const [method, path] = rest;
        if (!method || !path) usage("Usage: pnpm ziki request <METHOD> <path> [--body <json>] [--as <agent>]");
        const agent = resolveAgent(readKeyring(), single(flags, "as"));
        const bodyText = single(flags, "body");
        let body: Record<string, unknown> | undefined;
        if (bodyText !== undefined) {
          try {
            body = JSON.parse(bodyText) as Record<string, unknown>;
          } catch {
            usage("--body needs JSON.");
          }
        }
        const [pathOnly, queryString] = path.replace(/^\/api\/v1/, "").split("?");
        const query = Object.fromEntries(new URLSearchParams(queryString ?? ""));
        return await callApi(io, clientFor(agent, serverUrl), { method: method.toUpperCase() as RequestSpec["method"], path: pathOnly, query, body });
      }
      default: {
        const tool = findTool(command);
        if (!tool) usage(`Unknown command "${command}". Run \`pnpm ziki commands\`.`);
        if (flags.help) {
          io.out(toolHelp(tool));
          return EXIT.ok;
        }
        const agent = resolveAgent(readKeyring(), single(flags, "as"));
        const input = toolInput(tool.input, flags, GLOBAL_FLAGS);
        let spec: RequestSpec;
        try {
          spec = buildRequest(tool as ToolDef, input, { projectId: agent.projectId });
        } catch (error) {
          if (error && typeof error === "object" && "issues" in error) {
            const issues = (error as { issues: { path: PropertyKey[]; message: string }[] }).issues;
            usage(issues.map((issue) => `--${toKebab(String(issue.path[0] ?? "input"))}: ${issue.message}`).join("\n"));
          }
          throw error;
        }
        // A rotated key retires the old one, so keep the keyring in step.
        const saveRotatedKey =
          tool.name === "ziki_rotate_key"
            ? (data: unknown) => {
                const key = (data as { api_key?: string } | null)?.api_key;
                if (!key) return;
                const keyring = readKeyring();
                keyring.agents[agent.name] = { ...agent, key };
                writeKeyring(keyring);
              }
            : undefined;
        return await callApi(io, clientFor(agent, serverUrl), spec, saveRotatedKey);
      }
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.err(error.message);
      return EXIT.usage;
    }
    if (error instanceof CliEnvironmentError) {
      io.err(error.message);
      return EXIT.environment;
    }
    io.err(error instanceof Error ? error.message : String(error));
    return EXIT.usage;
  }
}
