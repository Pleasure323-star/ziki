import { describe, expect, it, vi } from "vitest";
import { issueHref, issuePath, parseIssueRef, queryString, resolveIssueRef } from "./issue-ref";

describe("parseIssueRef (#457)", () => {
  it("reads a bare issue number", () => {
    expect(parseIssueRef("123")).toEqual({ kind: "number", number: 123 });
    expect(parseIssueRef(" 7 ")).toEqual({ kind: "number", number: 7 });
  });

  it("reads a prefixed reference in any case", () => {
    expect(parseIssueRef("ZE-123")).toEqual({ kind: "number", number: 123 });
    expect(parseIssueRef("ziki-42")).toEqual({ kind: "number", number: 42 });
    expect(parseIssueRef("ZE%2D9")).toEqual({ kind: "number", number: 9 });
  });

  it("keeps internal ids, UUIDs and anything else as an id", () => {
    expect(parseIssueRef("cmvij0gc504zwrt01n8ffouaj")).toEqual({ kind: "id", id: "cmvij0gc504zwrt01n8ffouaj" });
    const uuid = "921502fe-2e98-46f7-8bfa-383330a455fb";
    expect(parseIssueRef(uuid)).toEqual({ kind: "id", id: uuid });
    expect(parseIssueRef("0")).toEqual({ kind: "id", id: "0" });
    expect(parseIssueRef("12345678901")).toEqual({ kind: "id", id: "12345678901" });
    expect(parseIssueRef("%E0%A4%A")).toEqual({ kind: "id", id: "%E0%A4%A" });
  });
});

describe("issuePath and queryString", () => {
  it("builds readable paths", () => {
    expect(issuePath("ziki", 42)).toBe("/ziki/42");
    expect(issuePath("ziki", 42, "/history")).toBe("/ziki/42/history");
  });

  it("encodes the project slug", () => {
    expect(issuePath("a b", 7)).toBe("/a%20b/7");
  });

  it("builds an issue's path from its project", () => {
    expect(issueHref({ number: 42, project: { slug: "ziki" } })).toBe("/ziki/42");
    expect(issueHref({ number: 42, project: { slug: "ziki" } }, "/history")).toBe("/ziki/42/history");
  });

  it("keeps every query parameter, repeated ones included", () => {
    expect(queryString({})).toBe("");
    expect(queryString({ comment: "c1", threads: ["a", "b"], skip: undefined })).toBe("?comment=c1&threads=a&threads=b");
  });
});

describe("resolveIssueRef", () => {
  const db = () => ({
    bug: {
      findFirst: vi.fn(async () => ({ id: "cm1", number: 5 })),
      findUnique: vi.fn(async () => ({ id: "cm1", number: 5 })),
    },
  });

  it("looks a number up inside the viewer's organisation only", async () => {
    const client = db();
    await expect(resolveIssueRef(client as never, { kind: "number", number: 5 }, { tenantId: "t1" })).resolves.toEqual({ id: "cm1", number: 5 });
    expect(client.bug.findFirst).toHaveBeenCalledWith({ where: { number: 5, tenantId: "t1" }, select: { id: true, number: true } });
  });

  it("does not guess a number's organisation when there is no tenant", async () => {
    const client = db();
    await expect(resolveIssueRef(client as never, { kind: "number", number: 5 }, {})).resolves.toBeNull();
    expect(client.bug.findFirst).not.toHaveBeenCalled();
  });

  it("keeps the scoped id lookup for old links", async () => {
    const client = db();
    await resolveIssueRef(client as never, { kind: "id", id: "cm1" }, { tenantId: "t1" });
    expect(client.bug.findUnique).toHaveBeenCalledWith({ where: { id: "cm1", tenantId: "t1" }, select: { id: true, number: true } });
  });
});
