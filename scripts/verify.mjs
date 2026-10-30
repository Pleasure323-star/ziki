#!/usr/bin/env node
/**
 * Local verification (AGENTS.md, "Testing"). The default sequence is:
 *
 *   finish the whole change → pnpm verify:ready → fix every failure together
 *   → pnpm verify:recheck → push; CI is the release gate.
 *
 *   pnpm verify:ready     lint, typecheck and the full unit suite, once. Every
 *                         phase runs and reports even when another fails.
 *   pnpm verify:recheck   after repairs: the full run's failing test files plus
 *                         the tests whose imports reach what changed since it;
 *                         lint and typecheck only when those changes affect them.
 *   pnpm verify:status    what the last full run and the rechecks since covered,
 *                         and whether the current files match either.
 *   pnpm verify:quick     diagnostic only: the tests affected by everything that
 *                         differs from origin/main. Not part of the default sequence.
 *
 * Results are keyed by the input state: every tracked and untracked file
 * (after .gitignore) by content, the Node version and platform, the installed
 * dependencies, the generated Prisma client, and a hash of the environment
 * variables in ENV_INPUTS. A full pass is reused only for that exact state.
 * Logs live in node_modules/.cache/verify/runs/, which is ignored, so writing
 * them never changes the state.
 *
 * Flags: --force (run even if this state already passed), --schedule
 * split|parallel|serial (ready only; see SCHEDULES), --timeout-minutes N.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TEST_FILE,
  affectedTests,
  changedBetween,
  changedEnvironment,
  duration,
  fullRunReason,
  importGraph,
  inputState,
  invalidatesTypecheck,
  lintTargets,
  misplacedTestFiles,
  posix,
  readEslintLog,
  readTscLog,
  readVitestReport,
  runPhase,
  runSchedule,
  scriptCommand,
  toolCommand,
} from "./verify/lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, "node_modules", ".cache", "verify");
const FULL_RECORD = path.join(CACHE, "full.json");
const RECHECKS = path.join(CACHE, "rechecks.json");

// Node keeps compiled bytecode here between runs, so later runs skip recompiling Vitest and dependencies.
const RUN_ENV = { ...process.env, NODE_COMPILE_CACHE: path.join(ROOT, "node_modules", ".cache", "node-compile-cache"), FORCE_COLOR: "0" };

/**
 * How the three phases of a full run share the machine. "split" runs lint and
 * typecheck side by side, then the suite on its own. Measured warm on 24 CPUs,
 * one run each: split 69s, parallel 66s with every phase slowed by contention
 * (the suite 59s → 66s). No clear win, so split stays the default.
 */
const SCHEDULES = {
  split: [["lint", "typecheck"], ["unit"]],
  parallel: [["lint", "typecheck", "unit"]],
  serial: [["lint"], ["typecheck"], ["unit"]],
};

const args = process.argv.slice(2);
const mode = args[0];
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const TIMEOUT_MS = Number(option("timeout-minutes", "20")) * 60_000;
const rel = (file) => posix(path.relative(ROOT, file));
const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
const say = (text = "") => console.log(text ? `[verify] ${text}` : "");

function revision() {
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8", timeout: 20_000 }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 }).trim().length > 0;
    return `${head}${dirty ? " + uncommitted changes" : ""}`;
  } catch {
    return "unknown revision";
  }
}

/** Unit tests are what vitest.config.ts includes; this mirrors its excludes for the recheck selection. */
const isUnitTest = (file) =>
  TEST_FILE.test(file) && !/^(e2e|packages|cli\/tests|test-results|playwright-report)\//.test(file) && !/(^|\/)(node_modules|\.claude|\.worktrees|\.next|coverage)\//.test(file);

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

function phaseCommand(name, runDir, { lintFiles, testFiles } = {}) {
  if (name === "lint") return scriptCommand(ROOT, "lint", lintFiles ?? []);
  if (name === "typecheck") return scriptCommand(ROOT, "typecheck");
  const [command, prefix] = toolCommand(ROOT, "vitest");
  return {
    command,
    args: [...prefix, "run", "--reporter=default", "--reporter=json", `--outputFile.json=${path.join(runDir, "unit.json")}`, ...(testFiles ?? [])],
  };
}

/** Adds what each phase's log says: problem counts, failing files, test counts. */
function describe(result, runDir) {
  const text = existsSync(result.logFile) ? readFileSync(result.logFile, "utf8") : "";
  if (result.name === "lint") {
    const lint = readEslintLog(text);
    return { ...result, detail: lint.problems ? `${lint.errors} errors, ${lint.warnings} warnings in ${lint.files.length} files` : "no problems", failingFiles: lint.files.map((file) => rel(file)) };
  }
  if (result.name === "typecheck") {
    const tsc = readTscLog(text);
    return { ...result, detail: tsc.errors ? `${tsc.errors} errors in ${tsc.files.length} files` : "no errors", failingFiles: tsc.files };
  }
  const report = readVitestReport(path.join(runDir, "unit.json"), ROOT);
  if (!report) return { ...result, detail: "no test report written (the run did not finish; see the log)", failingFiles: [] };
  const misplaced = misplacedTestFiles(report.testFiles, ROOT);
  const counted = { ...result, counts: { files: report.files, tests: report.tests, passed: report.passed, failed: report.failed, skipped: report.skipped }, failures: report.failures, failingFiles: report.failures.map((failure) => failure.file) };
  const detail = `${report.files} files, ${report.tests} tests: ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`;
  if (misplaced.length) {
    // The suite ran tests from a nested checkout or dependency: the discovery config is broken.
    return { ...counted, status: "failed", detail: `${detail}; ${misplaced.length} test files outside this checkout's suite (${misplaced.slice(0, 3).join(", ")}…)` };
  }
  return { ...counted, detail };
}

function runPhases(groups, runDir, inputs) {
  return runSchedule(groups, (name) => {
    const { command, args: phaseArgs } = phaseCommand(name, runDir, inputs);
    return runPhase({ name, command, args: phaseArgs, cwd: ROOT, env: RUN_ENV, logFile: path.join(runDir, `${name}.log`), timeoutMs: TIMEOUT_MS }).then((result) => describe(result, runDir));
  });
}

function printResults(title, results, seconds) {
  say(title);
  const rows = results.map((r) => [r.name, r.status === "passed" ? "passed" : r.status.toUpperCase(), duration(r.seconds), r.exitCode ?? "-", r.detail ?? r.error ?? "", rel(r.logFile)]);
  const widths = [9, 7, 7, 4, 0];
  console.log(`  ${"phase".padEnd(widths[0])}  ${"status".padEnd(widths[1])}  ${"time".padEnd(widths[2])}  ${"exit".padEnd(widths[3])}  result`);
  for (const [name, status, time, exit, detail, log] of rows) {
    console.log(`  ${name.padEnd(widths[0])}  ${status.padEnd(widths[1])}  ${time.padEnd(widths[2])}  ${String(exit).padEnd(widths[3])}  ${detail}`);
    console.log(`  ${"".padEnd(widths[0] + widths[1] + widths[2] + widths[3] + 8)}  log: ${log}`);
  }
  const failed = results.filter((r) => r.status !== "passed");
  for (const r of failed) {
    if (r.error) say(`${r.name}: ${r.error}`);
    if (r.failures?.length) {
      say(`${r.name}: ${r.failures.length} failing files`);
      for (const failure of r.failures) {
        console.log(`  ${failure.file}${failure.message ? `: ${failure.message}` : ""}`);
        for (const test of failure.tests) console.log(`    × ${test}`);
      }
    } else if (r.failingFiles?.length) {
      say(`${r.name}: ${r.failingFiles.join(", ")}`);
    }
  }
  say(`${failed.length ? `${failed.length} of ${results.length} phases failed` : `all ${results.length} phases passed`} in ${duration(seconds)} (elapsed).`);
  return failed.length === 0;
}

function newRunDir(kind) {
  const dir = path.join(CACHE, "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${kind}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const summary = (r) => ({ name: r.name, status: r.status, exitCode: r.exitCode, seconds: Math.round(r.seconds * 10) / 10, detail: r.detail, counts: r.counts, failingFiles: r.failingFiles, logFile: rel(r.logFile) });

/* ------------------------------------------------------------------ */
/* Modes                                                               */
/* ------------------------------------------------------------------ */

async function ready({ reason } = {}) {
  const schedule = option("schedule", "split");
  if (!SCHEDULES[schedule]) throw new Error(`--schedule must be one of ${Object.keys(SCHEDULES).join(", ")}`);
  mkdirSync(CACHE, { recursive: true });
  const state = inputState(ROOT);
  const passRecord = path.join(CACHE, "passes", `${state.key}.json`);
  if (!flag("force") && existsSync(passRecord)) {
    const pass = readJson(passRecord, {});
    say(`A full run already passed on this exact input state (${state.key.slice(0, 12)}, ${pass.revision}) at ${pass.at}. Nothing to run; --force runs it again.`);
    return true;
  }
  const at = new Date().toISOString();
  const rev = revision();
  const runDir = newRunDir("full");
  say(`Full run${reason ? ` (${reason})` : ""}: lint, typecheck and unit tests on ${rev}, input state ${state.key.slice(0, 12)}, Node ${process.versions.node}, ${os.cpus().length} CPUs, schedule ${schedule}.`);
  const started = Date.now();
  const results = await runPhases(SCHEDULES[schedule], runDir);
  const seconds = (Date.now() - started) / 1000;
  const ok = printResults(`Full run on ${rev} (input state ${state.key.slice(0, 12)}):`, results, seconds);
  const record = { kind: "full", at, revision: rev, key: state.key, environment: state.environment, files: state.files, schedule, seconds: Math.round(seconds), passed: ok, runDir: rel(runDir), phases: results.map(summary) };
  writeFileSync(FULL_RECORD, JSON.stringify(record));
  writeFileSync(RECHECKS, "[]");
  if (ok) {
    mkdirSync(path.dirname(passRecord), { recursive: true });
    writeFileSync(passRecord, JSON.stringify({ at, revision: rev, seconds: Math.round(seconds) }));
  } else {
    say("Read the failures above (full output in the logs), fix them all, then run `pnpm verify:recheck`.");
  }
  return ok;
}

async function recheck() {
  const full = readJson(FULL_RECORD, null);
  if (!full) {
    say("No full run is recorded for this checkout, so there is nothing to recheck against.");
    return ready({ reason: "no earlier full run" });
  }
  const state = inputState(ROOT);
  const rechecks = readJson(RECHECKS, []);
  if (state.key === full.key) {
    if (full.passed) {
      say(`Nothing changed since the full run at ${full.at}, which passed.`);
      return true;
    }
    say(`Nothing changed since the full run at ${full.at}; it failed, and running it again would give the same result.`);
    for (const phase of full.phases.filter((p) => p.status !== "passed")) say(`${phase.name}: ${phase.detail ?? phase.status} (log: ${phase.logFile})`);
    return false;
  }
  const already = rechecks.find((r) => r.key === state.key && r.passed);
  if (already && !flag("force")) {
    say(`A recheck already passed on this exact input state at ${already.at}. Nothing to run.`);
    return true;
  }
  const changed = changedBetween(full.files, state.files);
  const environmentChanges = changedEnvironment(full.environment, state.environment);
  const reason = fullRunReason(changed, environmentChanges);
  if (reason) {
    say(`A full run is needed: ${reason}.`);
    return ready({ reason });
  }

  const failed = (name) => full.phases.find((p) => p.name === name && p.status !== "passed");
  const exists = (file) => existsSync(path.join(ROOT, file));
  const graph = importGraph(ROOT);
  const affected = affectedTests(ROOT, changed, isUnitTest, graph);
  const tests = [...new Set([...(failed("unit")?.failingFiles ?? []).filter(exists), ...affected.tests])].sort();
  const lintFiles = [...new Set([...lintTargets(ROOT, changed), ...(failed("lint")?.failingFiles ?? []).filter(exists)])].sort();
  const typecheck = Boolean(failed("typecheck")) || invalidatesTypecheck(changed);

  say(`Recheck on ${revision()} against the full run at ${full.at} (${full.revision}): ${changed.length} files changed since.`);
  if (affected.unmapped.length) say(`No unit test reaches ${affected.unmapped.length} changed files: ${affected.unmapped.join(", ")}.`);
  const groups = [[...(lintFiles.length ? ["lint"] : []), ...(typecheck ? ["typecheck"] : [])], tests.length ? ["unit"] : []].filter((group) => group.length);
  if (!groups.length) {
    say("None of the changes affect lint, the types or any unit test. Nothing to rerun.");
    rechecks.push({ at: new Date().toISOString(), revision: revision(), key: state.key, changed, passed: true, phases: [], ran: { lintFiles, typecheck, tests } });
    writeFileSync(RECHECKS, JSON.stringify(rechecks));
    return true;
  }
  say(`Rerunning: ${[lintFiles.length ? `lint on ${lintFiles.length} files` : null, typecheck ? "typecheck" : null, tests.length ? `${tests.length} test files` : null].filter(Boolean).join(", ")}.`);
  const runDir = newRunDir("recheck");
  const started = Date.now();
  const results = await runPhases(groups, runDir, { lintFiles, testFiles: tests });
  const seconds = (Date.now() - started) / 1000;
  const ok = printResults("Recheck (targeted, not a full run):", results, seconds);
  rechecks.push({ at: new Date().toISOString(), revision: revision(), key: state.key, changed, passed: ok, seconds: Math.round(seconds), runDir: rel(runDir), ran: { lintFiles, typecheck, tests }, phases: results.map(summary) });
  writeFileSync(RECHECKS, JSON.stringify(rechecks));
  if (!ok) say("Fix these together, then run `pnpm verify:recheck` again.");
  return ok;
}

function status() {
  const full = readJson(FULL_RECORD, null);
  if (!full) {
    say("No full run recorded for this checkout.");
    return false;
  }
  const state = inputState(ROOT);
  const rechecks = readJson(RECHECKS, []);
  say(`Full run: ${full.passed ? "passed" : "FAILED"} at ${full.at} on ${full.revision}, input state ${full.key.slice(0, 12)}, ${duration(full.seconds)} (schedule ${full.schedule}).`);
  for (const phase of full.phases) console.log(`  ${phase.name.padEnd(9)}  ${phase.status.padEnd(7)}  ${duration(phase.seconds).padEnd(7)}  ${phase.detail ?? ""}  (${phase.logFile})`);
  rechecks.forEach((r, index) => {
    say(`Recheck ${index + 1}: ${r.passed ? "passed" : "FAILED"} at ${r.at} on ${r.revision}, input state ${r.key.slice(0, 12)}; ${r.changed.length} files changed since the full run; reran ${[r.ran.lintFiles.length ? `lint on ${r.ran.lintFiles.length} files` : null, r.ran.typecheck ? "typecheck" : null, r.ran.tests.length ? `${r.ran.tests.length} test files` : null].filter(Boolean).join(", ") || "nothing"}.`);
    for (const phase of r.phases) console.log(`  ${phase.name.padEnd(9)}  ${phase.status.padEnd(7)}  ${duration(phase.seconds).padEnd(7)}  ${phase.detail ?? ""}  (${phase.logFile})`);
  });
  const match = state.key === full.key ? "the full run" : rechecks.findLast((r) => r.key === state.key)?.passed ? "the last passing recheck (targeted, so the full suite has not run on these exact files)" : null;
  say(match ? `The current files match ${match}.` : `The current files match neither: ${changedBetween(full.files, state.files).length} files differ from the full run. Run \`pnpm verify:recheck\`.`);
  return Boolean(match) && (state.key === full.key ? full.passed : true);
}

async function quick() {
  let base = "HEAD";
  try {
    base = execFileSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: ROOT, encoding: "utf8", timeout: 20_000 }).trim();
  } catch {
    // No origin/main: compare with HEAD.
  }
  const listed = (gitArgs) => execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8", timeout: 60_000 }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const changed = [...new Set([...listed(["diff", "--name-only", base]), ...listed(["ls-files", "--others", "--exclude-standard"])])].sort();
  say("Diagnostic run (not part of the default sequence; `pnpm verify:ready` is the check).");
  if (!changed.length) {
    say("Nothing differs from origin/main.");
    return true;
  }
  const reason = fullRunReason(changed);
  if (reason) say(`Note: ${reason}; only a full run covers those.`);
  const { tests, unmapped } = affectedTests(ROOT, changed, isUnitTest);
  if (unmapped.length) say(`No unit test reaches: ${unmapped.join(", ")}.`);
  if (!tests.length) {
    say("No unit tests reach these changes.");
    return true;
  }
  const runDir = newRunDir("quick");
  const started = Date.now();
  const results = await runPhases([["unit"]], runDir, { testFiles: tests });
  return printResults(`Diagnostic: ${tests.length} test files for ${changed.length} changed files:`, results, (Date.now() - started) / 1000);
}

let ok;
try {
  if (mode === "ready") ok = await ready();
  else if (mode === "recheck") ok = await recheck();
  else if (mode === "status") ok = status();
  else if (mode === "quick") ok = await quick();
  else {
    console.error("Usage: node scripts/verify.mjs ready|recheck|status|quick [--force] [--schedule split|parallel|serial] [--timeout-minutes N]");
    ok = false;
  }
} catch (error) {
  // A phase that can't even start (a missing tool, git unavailable) is a failure, never a pass.
  console.error(`[verify] could not run: ${error instanceof Error ? error.stack : error}`);
  ok = false;
}
process.exit(ok ? 0 : 1);
