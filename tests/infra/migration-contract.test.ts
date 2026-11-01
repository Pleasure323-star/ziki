import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationDatabaseUrl } from "@/scripts/migration-database-url.mjs";

/**
 * Migrations advance the schema safely (AGENTS.md, Migrations): production
 * applies them at container start, so a migration Postgres can't run takes the
 * deploy down. Each is one SQL file applied in name order, a new enum value is
 * never used in the migration that adds it, and migrations run over a direct
 * connection, never the pooler.
 */
const MIGRATIONS = path.join(process.cwd(), "prisma", "migrations");
const folders = readdirSync(MIGRATIONS).filter((name) => statSync(path.join(MIGRATIONS, name)).isDirectory()).sort();
const sqlOf = (folder: string) => readFileSync(path.join(MIGRATIONS, folder, "migration.sql"), "utf8");

describe("the migration history", () => {
  it("is one migration.sql per folder, each named by the timestamp it applies in", () => {
    expect(folders.length).toBeGreaterThan(0);
    for (const folder of folders) {
      expect(existsSync(path.join(MIGRATIONS, folder, "migration.sql")), folder).toBe(true);
      expect(folder, folder).toMatch(/^\d{14}(_\w+)?$/);
    }
  });

  it("never uses a new enum value in the migration that adds it, which Postgres refuses", () => {
    const offenders: string[] = [];
    for (const folder of folders) {
      const sql = sqlOf(folder).replace(/--.*$/gm, "");
      const added = [...sql.matchAll(/ALTER TYPE\s+"?\w+"?\s+ADD VALUE\s+(?:IF NOT EXISTS\s+)?'(\w+)'/gi)].map((m) => m[1]);
      const others = sql.split(";").filter((statement) => statement.trim() && !/ADD VALUE/i.test(statement));
      for (const value of added) {
        if (others.some((statement) => statement.includes(`'${value}'`))) offenders.push(`${folder}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the connection migrations use", () => {
  const POOLED = "postgresql://user:secret-pooler@ep-example-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require";

  it("is the direct host behind a pooled URL, credentials and options kept", () => {
    const url = new URL(migrationDatabaseUrl(POOLED));
    expect(url.hostname).toBe("ep-example.c-7.us-east-2.aws.neon.tech");
    expect(url.password).toBe("secret-pooler");
    expect(url.searchParams.get("sslmode")).toBe("require");
  });

  it("is DIRECT_URL when set, and a local URL unchanged", () => {
    const direct = "postgresql://u:p@direct.example:5432/neondb";
    expect(migrationDatabaseUrl(POOLED, `"${direct}"`)).toBe(direct);
    const local = "postgresql://bugtracker:bugtracker@localhost:5433/bugtracker";
    expect(migrationDatabaseUrl(local)).toBe(local);
  });
});
