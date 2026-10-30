import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const isWindows = process.platform === "win32";

function jsPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function writePrismaStub(dir: string, script: string) {
  const binDir = join(dir, "node_modules/.bin");
  mkdirSync(binDir, { recursive: true });
  if (isWindows) {
    const mjsPath = join(binDir, "prisma.mjs");
    writeFileSync(mjsPath, script);
    const cmdPath = join(binDir, "prisma.cmd");
    writeFileSync(cmdPath, "@echo off\r\nnode \"%~dp0prisma.mjs\" %*\r\n");
  } else {
    const prisma = join(binDir, "prisma");
    writeFileSync(prisma, script);
    chmodSync(prisma, 0o755);
  }
}

/**
 * Runs scripts/migrate.mjs against a stand-in `prisma` binary, so the exit
 * code can be checked without a database (#580).
 */
const dirs: string[] = [];

function run(prismaExitCode: number, env: Record<string, string | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), "migrate-exit-"));
  dirs.push(dir);
  mkdirSync(join(dir, "scripts"));
  cpSync("scripts/migrate.mjs", join(dir, "scripts/migrate.mjs"));
  cpSync("scripts/migration-database-url.mjs", join(dir, "scripts/migration-database-url.mjs"));
  const callsLog = join(dir, "calls.log");
  let prismaScript: string;
  if (isWindows) {
    prismaScript = `import { appendFileSync } from "node:fs";
import { argv, env, exit } from "node:process";
const callsLog = '${jsPath(callsLog)}';
appendFileSync(callsLog, \`url=\${env.DATABASE_URL ?? ''}\\nprisma \${argv.slice(2).join(' ')}\\n\`);
exit(${prismaExitCode});
`;
  } else {
    prismaScript = `#!/bin/sh\necho "url=$DATABASE_URL" >> "${callsLog}"\necho "prisma $*" >> "${callsLog}"\nexit ${prismaExitCode}\n`;
  }
  writePrismaStub(dir, prismaScript);
  const result = spawnSync(process.execPath, ["scripts/migrate.mjs"], {
    cwd: dir,
    // Only what the script needs, so the parent's NODE_ENV and DATABASE_URL don't leak in.
    env: { PATH: process.env.PATH, ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  const calls = (() => {
    try {
      return readFileSync(callsLog, "utf8");
    } catch {
      return "";
    }
  })();
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls };
}

function runStub(script: string, env: Record<string, string | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), "migrate-exit-"));
  dirs.push(dir);
  mkdirSync(join(dir, "scripts"));
  cpSync("scripts/migrate.mjs", join(dir, "scripts/migrate.mjs"));
  cpSync("scripts/migration-database-url.mjs", join(dir, "scripts/migration-database-url.mjs"));
  const calls = join(dir, "calls.log");
  const replaced = script.replaceAll("__CALLS__", isWindows ? jsPath(calls) : calls);
  writePrismaStub(dir, replaced);
  const result = spawnSync(process.execPath, ["scripts/migrate.mjs"], {
    cwd: dir,
    env: { PATH: process.env.PATH, ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  const log = (() => {
    try {
      return readFileSync(calls, "utf8");
    } catch {
      return "";
    }
  })();
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls: log };
}

function initThenSuccessStub() {
  if (isWindows) {
    return `import { appendFileSync, readFileSync } from "node:fs";
import { argv, exit } from "node:process";
const callsLog = '__CALLS__';
const args = argv.slice(2).join(' ');
appendFileSync(callsLog, \`prisma \${args}\\n\`);
if (/db\\ execute/.test(args)) { exit(0); }
if (/migrate\\ resolve/.test(args)) { exit(0); }
if (/migrate\\ deploy/.test(args)) {
  try {
    const calls = readFileSync(callsLog, "utf8");
    const n = (calls.match(/migrate deploy/g) || []).length;
    if (n === 1) {
      console.error("Error: P3009");
      console.error("The \`20261014193427_init\` migration started at 2026-10-15 10:32:25.619809 UTC failed");
      exit(1);
    }
  } catch {}
  exit(0);
}
exit(1);
`;
  }
  return `#!/bin/sh
echo "prisma $*" >> "__CALLS__"
case "$*" in
  *db\\ execute*) exit 0 ;;
  *migrate\\ resolve*) exit 0 ;;
  *migrate\\ deploy*)
    n=$(grep -c "migrate deploy" "__CALLS__" || true)
    if [ "$n" -eq 1 ]; then
      echo "Error: P3009" >&2
      echo 'The \`20261014193427_init\` migration started at 2026-10-15 10:32:25.619809 UTC failed' >&2
      exit 1
    fi
    exit 0
    ;;
esac
exit 1
`;
}

function initMissingUserStub() {
  if (isWindows) {
    return `import { appendFileSync } from "node:fs";
import { argv, exit } from "node:process";
const callsLog = '__CALLS__';
const args = argv.slice(2).join(' ');
appendFileSync(callsLog, \`prisma \${args}\\n\`);
if (/db\\ execute/.test(args)) { console.error("missing User"); exit(1); }
if (/migrate\\ deploy/.test(args)) {
  console.error("Error: P3009");
  console.error("The \`20261014193427_init\` migration started at 2026-10-15 10:32:25.619809 UTC failed");
  exit(1);
}
exit(1);
`;
  }
  return `#!/bin/sh
echo "prisma $*" >> "__CALLS__"
case "$*" in
  *db\\ execute*) echo "missing User" >&2; exit 1 ;;
  *migrate\\ deploy*)
    echo "Error: P3009" >&2
    echo 'The \`20261014193427_init\` migration started at 2026-10-15 10:32:25.619809 UTC failed' >&2
    exit 1
    ;;
esac
exit 1
`;
}

function duplicateColumnStub() {
  if (isWindows) {
    return `import { appendFileSync, readFileSync } from "node:fs";
import { argv, exit } from "node:process";
const callsLog = '__CALLS__';
const args = argv.slice(2).join(' ');
appendFileSync(callsLog, \`prisma \${args}\\n\`);
if (/db\\ execute/.test(args)) { exit(0); }
if (/migrate\\ resolve/.test(args)) { exit(0); }
if (/migrate\\ deploy/.test(args)) {
  try {
    const calls = readFileSync(callsLog, "utf8");
    const n = (calls.match(/migrate deploy/g) || []).length;
    if (n === 1) {
      console.error("Error: P3009");
      console.error("The \`20261014193427_init\` migration started at 2026-10-15 10:32:25.619809 UTC failed");
      exit(1);
    }
    if (n === 2) {
      console.error("Error: P3018");
      console.error("Migration name: 20261014195331_add_votes_and_proof_links");
      console.error("Database error code: 42701");
      console.error('ERROR: column "voteCount" of relation "Bug" already exists');
      exit(1);
    }
  } catch {}
  exit(0);
}
exit(1);
`;
  }
  return `#!/bin/sh
echo "prisma $*" >> "__CALLS__"
case "$*" in
  *db\\ execute*) exit 0 ;;
  *migrate\\ resolve*) exit 0 ;;
  *migrate\\ deploy*)
    n=$(grep -c "migrate deploy" "__CALLS__" || true)
    if [ "$n" -eq 1 ]; then
      echo "Error: P3009" >&2
      echo 'The \`20261014193427_init\` migration started at 2026-10-15 10:32:25.619809 UTC failed' >&2
      exit 1
    fi
    if [ "$n" -eq 2 ]; then
      echo "Error: P3018" >&2
      echo "Migration name: 20261014195331_add_votes_and_proof_links" >&2
      echo "Database error code: 42701" >&2
      echo "ERROR: column \"voteCount\" of relation \"Bug\" already exists" >&2
      exit 1
    fi
    exit 0
    ;;
esac
exit 1
`;
}

/** First deploy: the idea verdicts migration is recorded as failed. `db execute` is the rollback probe. */
function rolledBackStub(probeExit: number, name = "20261130000000_idea_verdicts") {
  if (isWindows) {
    return `import { appendFileSync, readFileSync } from "node:fs";
import { argv, exit } from "node:process";
const callsLog = '__CALLS__';
const args = argv.slice(2).join(' ');
appendFileSync(callsLog, \`prisma \${args}\n\`);
if (/db\\ execute/.test(args)) { exit(${probeExit}); }
if (/migrate\\ resolve/.test(args)) { exit(0); }
if (/migrate\\ deploy/.test(args)) {
  const n = (readFileSync(callsLog, "utf8").match(/migrate deploy/g) || []).length;
  if (n === 1) {
    console.error("Error: P3009");
    console.error("The \`${name}\` migration started at 2026-10-29 13:00:33.229929 UTC failed");
    exit(1);
  }
  exit(0);
}
exit(1);
`;
  }
  return `#!/bin/sh
echo "prisma $*" >> "__CALLS__"
case "$*" in
  *db\\ execute*) exit ${probeExit} ;;
  *migrate\\ resolve*) exit 0 ;;
  *migrate\\ deploy*)
    n=$(grep -c "migrate deploy" "__CALLS__" || true)
    if [ "$n" -eq 1 ]; then
      echo "Error: P3009" >&2
      echo 'The \`${name}\` migration started at 2026-10-29 13:00:33.229929 UTC failed' >&2
      exit 1
    fi
    exit 0
    ;;
esac
exit 1
`;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DB = "postgresql://u:p@localhost:5432/db";

describe("scripts/migrate.mjs exit code (#580)", () => {
  it("exits 0 when migrations apply", () => {
    const { status, calls } = run(0, { NODE_ENV: "production", DATABASE_URL: DB });
    expect(status).toBe(0);
    expect(calls).toContain("prisma migrate deploy");
  });

  it("exits non-zero in production when migrations still fail after every repair", () => {
    const { status, output } = run(1, { NODE_ENV: "production", DATABASE_URL: DB });
    expect(status).toBe(1);
    expect(output).toContain("Not starting the server");
  });

  it("can be told to start anyway during an incident", () => {
    const { status } = run(1, { NODE_ENV: "production", DATABASE_URL: DB, ALLOW_START_WITH_FAILED_MIGRATION: "true" });
    expect(status).toBe(0);
  });

  it("only warns outside production", () => {
    const { status, output } = run(1, { NODE_ENV: "development", DATABASE_URL: DB });
    expect(status).toBe(0);
    expect(output).toContain("Continuing outside production");
  });

  it("refuses to start in production with no DATABASE_URL (#220)", () => {
    const { status, calls } = run(0, { NODE_ENV: "production" });
    expect(status).toBe(1);
    expect(calls).toBe("");
  });

  it("migrates through the direct Neon host when DATABASE_URL is pooled", () => {
    const pooled =
      "postgresql://user:secret-pooler@ep-example-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require";
    const { status, calls, output } = run(0, { NODE_ENV: "production", DATABASE_URL: pooled });
    expect(status).toBe(0);
    expect(calls).toContain("ep-example.c-7.us-east-2.aws.neon.tech");
    expect(calls).not.toContain("ep-example-pooler");
    expect(output).toContain("direct connection");
  });

  it("records the failed init migration as applied when User already exists", () => {
    const { status, calls, output } = runStub(initThenSuccessStub(), {
      NODE_ENV: "production",
      DATABASE_URL: DB,
    });
    expect(status).toBe(0);
    expect(calls).toContain("migrate resolve --applied 20261014193427_init");
    expect(output).toContain("User already exists");
  });

  it("does not mark init applied when the User table is missing", () => {
    const { status, calls } = runStub(initMissingUserStub(), {
      NODE_ENV: "production",
      DATABASE_URL: DB,
    });
    expect(status).toBe(1);
    expect(calls).not.toContain("migrate resolve");
  });

  it("records a later migration applied when its objects already exist", () => {
    const { status, calls } = runStub(duplicateColumnStub(), {
      NODE_ENV: "production",
      DATABASE_URL: DB,
    });
    expect(status).toBe(0);
    expect(calls).toContain("migrate resolve --applied 20261014193427_init");
    expect(calls).toContain("migrate resolve --applied 20261014195331_add_votes_and_proof_links");
  });

  it("reruns a known migration that failed and rolled back cleanly", () => {
    const { status, calls, output } = runStub(rolledBackStub(0), { NODE_ENV: "production", DATABASE_URL: DB });
    expect(status).toBe(0);
    expect(calls).toContain("migrate resolve --rolled-back 20261130000000_idea_verdicts");
    expect(calls).not.toContain("migrate resolve --applied 20261130000000_idea_verdicts");
    expect((calls.match(/migrate deploy/g) ?? []).length).toBe(2);
    expect(output).toContain("rolled back cleanly");
  });

  it("reruns the confirmation-stage comments migration once nothing of it is left (#298)", () => {
    const name = "20261209000000_confirmation_stage_comments";
    const { status, calls } = runStub(rolledBackStub(0, name), { NODE_ENV: "production", DATABASE_URL: DB });
    expect(status).toBe(0);
    expect(calls).toContain(`migrate resolve --rolled-back ${name}`);
    expect(calls).not.toContain(`migrate resolve --applied ${name}`);
  });

  it("does not rerun it when its objects are already there", () => {
    const { status, calls } = runStub(rolledBackStub(1), { NODE_ENV: "production", DATABASE_URL: DB });
    expect(status).toBe(1);
    expect(calls).not.toContain("migrate resolve");
  });

  it("the Dockerfile only starts the server when the script succeeds", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    expect(dockerfile).toMatch(/node scripts\/migrate\.mjs && (pnpm run start|node server\.js)/);
    expect(dockerfile).not.toContain("migrate.mjs || true");
  });
});
