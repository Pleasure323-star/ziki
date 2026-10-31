import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../packages/mcp-server/src/tools";
import { CLI_TOOLS, commandName, findTool } from "./catalog";

const API_ROOT = path.resolve(__dirname, "../app/api/v1");

/** The route file a tool's path maps to: `{id}` matches whichever `[param]` folder is there. */
function routeFile(route: string): string | undefined {
  let dir = API_ROOT;
  for (const segment of route.split("?")[0].split("/").filter(Boolean)) {
    if (segment.startsWith("{")) {
      const param = readdirSync(dir).find((entry) => entry.startsWith("[") && !entry.startsWith("[..."));
      if (!param) return undefined;
      dir = path.join(dir, param);
    } else {
      dir = path.join(dir, segment);
    }
    if (!existsSync(dir)) return undefined;
  }
  const file = path.join(dir, "route.ts");
  return existsSync(file) ? file : undefined;
}

describe("the CLI catalogue", () => {
  it("includes every MCP tool, then the CLI's own additions", () => {
    expect(CLI_TOOLS.slice(0, TOOLS.length).map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name));
    expect(CLI_TOOLS.length).toBeGreaterThan(TOOLS.length);
  });

  it("gives every tool a unique command name", () => {
    const names = CLI_TOOLS.map(commandName);
    expect(new Set(names).size).toBe(names.length);
    expect(commandName({ name: "ziki_create_idea" })).toBe("create-idea");
    expect(findTool("create-idea")?.name).toBe("ziki_create_idea");
    expect(findTool("nothing-like-this")).toBeUndefined();
  });

  it("points each of the CLI's own commands at a route that exists and handles its method", () => {
    for (const tool of CLI_TOOLS.slice(TOOLS.length)) {
      const file = routeFile(tool.route);
      expect(file, `${commandName(tool)}: no route for ${tool.route}`).toBeTruthy();
      expect(readFileSync(file!, "utf8"), `${commandName(tool)}: ${tool.route} has no ${tool.method}`).toMatch(
        new RegExp(`export (async function ${tool.method}\\(|const ${tool.method} = (?!apiMethodNotAllowed))`),
      );
    }
  });

  it("leaves out the decisions only a person may make", () => {
    const routes = CLI_TOOLS.map((tool) => tool.route);
    expect(routes.some((route) => /\/redesigns\/\{[^}]+\}\/decision/.test(route))).toBe(false);
  });
});
