import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { misplacedTestFiles } from "./lib.mjs";

/**
 * `pnpm test` finds only this checkout's unit tests (vitest.config.ts). Uses
 * Vitest's own discovery (`vitest list --filesOnly`), with the real config,
 * on a throwaway tree and on this checkout.
 */
const ROOT = path.resolve(__dirname, "../..");
const vitest = path.join(ROOT, "node_modules", "vitest", JSON.parse(readFileSync(path.join(ROOT, "node_modules", "vitest", "package.json"), "utf8")).bin.vitest);
const list = (root: string) =>
  (JSON.parse(execFileSync(process.execPath, [vitest, "list", "--filesOnly", "--json", "--config", path.join(ROOT, "vitest.config.ts"), "--root", root], { cwd: ROOT, encoding: "utf8", timeout: 60_000 })) as { file: string }[])
    .map((entry) => path.relative(root, entry.file).split(path.sep).join("/"))
    .sort();

// Each listing starts Vitest, which takes a few seconds; the listing itself is bounded at 60s.
const LISTING_TIMEOUT = 60_000;
const tree = mkdtempSync(path.join(tmpdir(), "discovery-"));
afterAll(() => rmSync(tree, { recursive: true, force: true }));

describe("unit test discovery", () => {
  it("leaves out nested checkouts, dependencies, build output and the other suites", () => {
    const files = [
      "lib/a.test.ts",
      "components/b.dom.test.tsx",
      ".github/workflows/c.workflow.test.ts",
      ".claude/worktrees/other/lib/a.test.ts",
      "sub/.claude/worktrees/deep/x.test.ts",
      ".worktrees/other/lib/a.test.ts",
      "node_modules/pkg/x.test.ts",
      ".next/server/x.test.ts",
      "coverage/x.test.ts",
      "e2e/flow.spec.ts",
      "packages/mcp-server/src/x.test.ts",
      "cli/tests/x.scenario.ts",
      "cli/tests/helpers.test.ts",
    ];
    for (const file of files) {
      mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
      writeFileSync(path.join(tree, file), "export {};\n");
    }
    expect(list(tree)).toEqual([".github/workflows/c.workflow.test.ts", "components/b.dom.test.tsx", "lib/a.test.ts"]);
  }, LISTING_TIMEOUT);

  it("finds no test outside this checkout's own suite here", () => {
    const found = list(ROOT);
    expect(found.length).toBeGreaterThan(100);
    expect(misplacedTestFiles(found, ROOT)).toEqual([]);
  }, LISTING_TIMEOUT);
});
