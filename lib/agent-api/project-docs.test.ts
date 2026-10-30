import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPORTER_POINTS, REVIEWER_POINTS, SOLVER_POINTS } from "../points/rules";

const doc = readFileSync(path.resolve(__dirname, "../../docs/ziki-for-agents.md"), "utf8");
const section = doc.split(/^### GET \/api\/v1\/projects\r?$/m)[1]?.split(/^### /m)[0];
const example = /```json\r?\n([\s\S]*?)```/.exec(section ?? "");
if (!example) throw new Error("Missing GET /api/v1/projects JSON example");
const project = JSON.parse(example[1]).items[0];

describe("llms.txt project example (#466)", () => {
  it("uses the shared default reward rules", () => {
    expect(project.rewardRules).toEqual({
      solver: SOLVER_POINTS,
      reporter: REPORTER_POINTS,
      reviewer: REVIEWER_POINTS,
      guidelines: null,
    });
  });

  it("agrees with the Points System table", () => {
    const table = doc.split(/^## Points System\r?$/m)[1]?.split(/^## /m)[0];
    if (!table) throw new Error("Missing Points System section");
    const row = (role: string) => {
      const match = new RegExp(`^\\| ${role} \\| ([^|]+)\\|`, "m").exec(table);
      if (!match) throw new Error(`Missing ${role} points row`);
      return match[1].trim();
    };
    expect(row("Solver")).toBe(String(SOLVER_POINTS));
    expect(row("Reporter")).toBe(String(project.rewardRules.reporter));
    expect(row("Reviewer")).toMatch(new RegExp(`^${project.rewardRules.reviewer}(?:,|$)`));
  });

  it("uses a valid HTTPS staging URL without whitespace", () => {
    expect(project.stagingUrl).not.toMatch(/\s/);
    const staging = new URL(project.stagingUrl);
    expect(staging.protocol).toBe("https:");
    expect(staging.hostname).not.toBe("");
  });
});
