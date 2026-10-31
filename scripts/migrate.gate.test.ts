import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Container start runs only `migrate deploy`; repairs are opt-in and logged (#581). */
const source = readFileSync("scripts/migrate.mjs", "utf8");

describe("container migration script (#581)", () => {
  it("runs migrate deploy before any repair step", () => {
    const deployAt = source.indexOf('runPrisma("migrate deploy")');
    const firstEnsure = source.indexOf("--file scripts/sql/ensure-bug-number.sql");
    expect(deployAt).toBeGreaterThan(-1);
    expect(firstEnsure).toBeGreaterThan(deployAt);
  });

  it("gates every repair behind MIGRATION_REPAIR=1", () => {
    expect(source).toContain("MIGRATION_REPAIR");
    const gateAt = source.indexOf("MIGRATION_REPAIR");
    const firstEnsure = source.indexOf("--file scripts/sql/ensure-bug-number.sql");
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(firstEnsure);
  });
});
