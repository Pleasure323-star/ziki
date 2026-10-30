import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  affectedTests,
  changedBetween,
  changedEnvironment,
  fullRunReason,
  inputState,
  invalidatesTypecheck,
  isAlive,
  misplacedTestFiles,
  readEslintLog,
  readTscLog,
  readVitestReport,
  runPhase,
  runSchedule,
  startServer,
  tail,
  waitForReady,
} from "./lib.mjs";

/** The verification tooling itself (AGENTS.md, "Testing"): its failure cases, against throwaway directories. */

const temps: string[] = [];
const servers: Server[] = [];
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-test-"));
  temps.push(dir);
  return dir;
}
function write(root: string, file: string, text: string) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const node = process.execPath;

describe("phases", () => {
  it("runs every group whatever the earlier ones returned, so a failure hides nothing", async () => {
    const ran: string[] = [];
    const results = await runSchedule([["lint", "typecheck"], ["unit"]], async (name: string) => {
      ran.push(name);
      return { name, status: name === "lint" ? "failed" : "passed" };
    });
    expect(ran).toEqual(["lint", "typecheck", "unit"]);
    expect(results.map((r: { status: string }) => r.status)).toEqual(["failed", "passed", "passed"]);
  });

  it("reports a failing command as failed with its exit code, and keeps all of its output in the log", async () => {
    const dir = temp();
    const logFile = path.join(dir, "logs", "phase.log");
    // exitCode, not process.exit(): on POSIX a pipe is written asynchronously, and exit() would drop the child's own unflushed output.
    const script = "for (let i = 0; i < 20000; i++) { console.log('out ' + i); console.error('err ' + i); } process.exitCode = 3;";
    const result = await runPhase({ name: "x", command: node, args: ["-e", script], cwd: dir, logFile, timeoutMs: 60_000 });
    expect(result).toMatchObject({ status: "failed", exitCode: 3 });
    const log = readFileSync(logFile, "utf8");
    expect(log.match(/^out \d+$/gm)).toHaveLength(20000);
    expect(log.match(/^err \d+$/gm)).toHaveLength(20000);
    expect(log).toContain("out 19999");
    expect(log).toContain("# failed (exit 3)");
  });

  it("stops a phase that runs past its timeout and says so", async () => {
    const dir = temp();
    const started = Date.now();
    const result = await runPhase({ name: "slow", command: node, args: ["-e", "console.log('started'); setInterval(() => {}, 1000)"], cwd: dir, logFile: path.join(dir, "slow.log"), timeoutMs: 800 });
    expect(result.status).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(readFileSync(path.join(dir, "slow.log"), "utf8")).toMatch(/started[\s\S]*timed out/);
  });

  it("reports a command that can't start as an error, not a pass", async () => {
    const dir = temp();
    const result = await runPhase({ name: "missing", command: path.join(dir, "no-such-tool"), args: [], cwd: dir, logFile: path.join(dir, "m.log"), timeoutMs: 10_000 });
    expect(result.status).toBe("error");
  });
});

describe("the input state", () => {
  function repo() {
    const root = temp();
    execFileSync("git", ["init", "-q"], { cwd: root });
    write(root, ".gitignore", "node_modules/\n");
    write(root, "lib/a.ts", "export const a = 1;\n");
    return root;
  }

  it("is unchanged by logs written under node_modules/.cache", () => {
    const root = repo();
    const before = inputState(root, {});
    write(root, "node_modules/.cache/verify/runs/x/unit.log", "lots of output");
    write(root, "node_modules/.cache/verify/full.json", "{}");
    expect(inputState(root, {}).key).toBe(before.key);
  });

  it("changes with a tracked or untracked file, and names the files", () => {
    const root = repo();
    const before = inputState(root, {});
    write(root, "lib/a.ts", "export const a = 2;\n");
    const edited = inputState(root, {});
    expect(edited.key).not.toBe(before.key);
    write(root, "lib/new.test.ts", "it('x', () => {});\n");
    const added = inputState(root, {});
    expect(added.key).not.toBe(edited.key);
    expect(changedBetween(before.files, added.files)).toEqual(["lib/a.ts", "lib/new.test.ts"]);
  });

  it("changes with the environment variables that affect the checks, and a recheck turns into a full run", () => {
    const root = repo();
    const before = inputState(root, { TZ: "UTC" });
    const after = inputState(root, { TZ: "Africa/Lagos" });
    expect(after.key).not.toBe(before.key);
    expect(changedEnvironment(before.environment, after.environment)).toEqual(["env"]);
    expect(fullRunReason([], ["env"])).toMatch(/environment changed/);
    // Unrelated variables are not inputs.
    expect(inputState(root, { TZ: "UTC", SOME_OTHER: "x" }).key).toBe(before.key);
  });

  it("reruns typecheck for TypeScript, JavaScript (allowJs) and tsconfig changes, not for docs", () => {
    expect(invalidatesTypecheck(["scripts/verify/lib.mjs"])).toBe(true);
    expect(invalidatesTypecheck(["lib/a.ts"])).toBe(true);
    expect(invalidatesTypecheck(["tsconfig.json"])).toBe(true);
    expect(invalidatesTypecheck(["AGENTS.md", "docs/cli.md"])).toBe(false);
  });

  it("asks for a full run when a shared input changes", () => {
    expect(fullRunReason(["pnpm-lock.yaml", "lib/a.ts"])).toMatch(/pnpm-lock\.yaml/);
    expect(fullRunReason(["vitest.config.ts"])).toMatch(/vitest\.config\.ts/);
    expect(fullRunReason(["prisma/schema.prisma"])).toMatch(/schema\.prisma/);
    expect(fullRunReason(["lib/a.ts", "docs/x.md"])).toBeNull();
  });
});

describe("affected tests", () => {
  function tree() {
    const root = temp();
    write(root, "lib/a.ts", "export const a = 1;\n");
    write(root, "lib/b.ts", 'import { a } from "./a";\nexport const b = a;\n');
    write(root, "lib/b.test.ts", 'import { b } from "@/lib/b";\n');
    write(root, "lib/c.test.ts", 'vi.mock("@/lib/a", () => ({}));\n');
    write(root, "lib/d.test.ts", "export {};\n");
    write(root, "lib/e.test.ts", 'readFileSync("data/fixture.json");\n');
    write(root, "data/fixture.json", "{}");
    write(root, ".claude/worktrees/x/lib/b.test.ts", 'import { b } from "@/lib/b";\n');
    return root;
  }
  const unit = () => true;

  it("follows imports through other files, and vi.mock targets", () => {
    expect(affectedTests(tree(), ["lib/a.ts"], unit).tests).toEqual(["lib/b.test.ts", "lib/c.test.ts"]);
  });

  it("finds tests that read a non-code file, and lists files no test reaches", () => {
    const root = tree();
    write(root, "docs/notes.md", "x");
    const result = affectedTests(root, ["data/fixture.json", "docs/notes.md"], unit);
    expect(result.tests).toEqual(["lib/e.test.ts"]);
    expect(result.unmapped).toEqual(["docs/notes.md"]);
  });

  it("follows a deleted file to whatever still imports it", () => {
    const root = tree();
    rmSync(path.join(root, "lib/a.ts"));
    expect(affectedTests(root, ["lib/a.ts"], unit).tests).toEqual(["lib/b.test.ts", "lib/c.test.ts"]);
  });

  it("includes a changed test file and never a nested checkout's copy", () => {
    const result = affectedTests(tree(), ["lib/d.test.ts", "lib/b.ts"], unit);
    expect(result.tests).toEqual(["lib/b.test.ts", "lib/d.test.ts"]);
  });
});

describe("reading results", () => {
  it("reads test counts and failures from Vitest's JSON report", () => {
    const dir = temp();
    const file = path.join(dir, "unit.json");
    writeFileSync(
      file,
      JSON.stringify({
        numTotalTests: 3,
        numPassedTests: 1,
        numFailedTests: 1,
        numPendingTests: 1,
        numTodoTests: 0,
        testResults: [
          { name: path.join(dir, "a.test.ts"), status: "failed", assertionResults: [{ status: "failed", fullName: "a fails" }, { status: "passed" }] },
          { name: path.join(dir, "b.test.ts"), status: "failed", message: "SyntaxError: bad\n at x", assertionResults: [] },
          { name: path.join(dir, "c.test.ts"), status: "passed", assertionResults: [{ status: "skipped" }] },
        ],
      }),
    );
    expect(readVitestReport(file, dir)).toMatchObject({
      files: 3,
      failedFiles: 2,
      tests: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      failures: [{ file: "a.test.ts", tests: ["a fails"] }, { file: "b.test.ts", tests: [], message: "SyntaxError: bad" }],
    });
    expect(readVitestReport(path.join(dir, "missing.json"), dir)).toBeNull();
  });

  it("reads ESLint and tsc output", () => {
    expect(readEslintLog("\nD:\\repo\\lib\\a.ts\n  1:1  error  x  rule\n\n✖ 2 problems (1 error, 1 warning)\n")).toEqual({ problems: 2, errors: 1, warnings: 1, files: ["D:\\repo\\lib\\a.ts"] });
    expect(readEslintLog("")).toMatchObject({ problems: 0, files: [] });
    expect(readTscLog("lib/a.ts(3,7): error TS2322: no\nlib/a.ts(4,1): error TS2304: no\nlib/b.ts(1,1): error TS1005: no\n")).toEqual({ errors: 3, files: ["lib/a.ts", "lib/b.ts"] });
  });

  it("flags test files from nested checkouts and dependencies", () => {
    const root = path.join(tmpdir(), "repo");
    const files = [path.join(root, "lib/a.test.ts"), path.join(root, ".claude/worktrees/x/lib/a.test.ts"), path.join(root, "node_modules/p/x.test.ts"), path.join(root, ".worktrees/y/b.test.ts")];
    expect(misplacedTestFiles(files, root)).toEqual([".claude/worktrees/x/lib/a.test.ts", "node_modules/p/x.test.ts", ".worktrees/y/b.test.ts"]);
  });
});

describe("waiting for a server", () => {
  function serve(handler: (count: number) => number): Promise<string> {
    let count = 0;
    const server = createServer((_, res) => {
      count += 1;
      res.statusCode = handler(count);
      res.end();
    });
    servers.push(server);
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`)));
  }

  it("is ready once health answers 200", async () => {
    const url = await serve((count) => (count < 3 ? 503 : 200));
    const wait = await waitForReady({ url, timeoutMs: 10_000, intervalMs: 50 });
    expect(wait).toMatchObject({ ready: true, attempts: 3 });
  });

  it("gives up at the timeout with what it last saw", async () => {
    const url = await serve(() => 503);
    const started = Date.now();
    const wait = await waitForReady({ url, timeoutMs: 600, intervalMs: 100 });
    expect(wait.ready).toBe(false);
    expect(wait.last).toMatchObject({ ok: false, status: 503 });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("times out on a server that never listens, keeps its log, and stops it", async () => {
    const dir = temp();
    const server = startServer({ command: node, args: ["-e", "console.log('booting'); console.error('still compiling'); setInterval(() => {}, 1000)"], cwd: dir, env: process.env, logFile: path.join(dir, "server.log") });
    const wait = await waitForReady({ url: "http://127.0.0.1:9/api/health", timeoutMs: 1_000, intervalMs: 100, child: server.child });
    expect(wait.ready).toBe(false);
    expect(wait.last?.status).toBeNull();
    await server.stop();
    expect(tail(server.logFile)).toMatch(/booting[\s\S]*still compiling/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isAlive(server.child.pid)).toBe(false);
  });

  it("stops waiting as soon as the server exits", async () => {
    const dir = temp();
    const server = startServer({ command: node, args: ["-e", "console.error('port in use'); process.exit(1)"], cwd: dir, env: process.env, logFile: path.join(dir, "server.log") });
    const wait = await waitForReady({ url: "http://127.0.0.1:9/api/health", timeoutMs: 30_000, intervalMs: 100, child: server.child });
    expect(wait).toMatchObject({ ready: false, exited: { code: 1 } });
    expect(wait.seconds).toBeLessThan(10);
    await server.stop();
  });
});
