import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * /org/members lists one organization's members and orders them in the
 * database. `orderBy: { role: "asc" }` puts owners first only while
 * MembershipRole is declared owner, admin, member — Postgres sorts an enum
 * by its declaration order. Reordering the enum would silently shuffle that
 * page, so pin it here.
 */
describe("MembershipRole enum declaration order", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");

  it("is most to least privileged, which is what the members page sorts ascending", () => {
    const block = schema.match(/enum MembershipRole \{([^}]*)\}/);
    expect(block, "enum MembershipRole not found in schema.prisma").not.toBeNull();
    const members = block![1]
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter(Boolean);
    expect(members).toEqual(["owner", "admin", "member"]);
  });
});

describe("Role enum declaration order", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");

  it("stays least to most privileged", () => {
    const block = schema.match(/enum Role \{([^}]*)\}/);
    expect(block, "enum Role not found in schema.prisma").not.toBeNull();
    const members = block![1]
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter((line) => line && !line.startsWith("///"));
    expect(members).toEqual(["user", "admin", "super_admin"]);
  });
});
