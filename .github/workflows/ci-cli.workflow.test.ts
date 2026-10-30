import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** CI runs the CLI scenarios on every PR, so local runs can be limited to API changes (AGENTS.md, "CLI tests"). */
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const job = ci.slice(ci.indexOf("\n  cli:"), ci.indexOf("\n  e2e:"));

describe("the CLI scenarios job", () => {
  it("runs on pull requests, with its own database", () => {
    expect(ci).toMatch(/on:\r?\n\s+pull_request:/);
    expect(job).toContain("image: postgres:16");
    expect(job).toMatch(/DATABASE_URL: "postgresql:\/\/postgres:postgres@localhost:5432\/bug_tracker_cli"/);
  });

  it("migrates, then runs the scenarios through the runner that starts, waits for and stops the server", () => {
    expect(job).toContain("pnpm exec prisma migrate deploy");
    expect(job).not.toMatch(/db:seed|db seed|migrate reset|db push/);
    expect(job).toMatch(/node scripts\/cli-tests\.mjs --ready-timeout \d+/);
    expect(job).toMatch(/timeout-minutes: \d+/);
  });

  it("keeps the logs when it fails", () => {
    expect(job).toMatch(/if: failure\(\)[\s\S]*upload-artifact[\s\S]*path: cli-test-logs\//);
    expect(job).toContain("CLI_TEST_LOG_DIR: cli-test-logs");
  });
});
