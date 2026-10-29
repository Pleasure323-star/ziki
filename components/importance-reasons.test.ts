import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImportanceReasons } from "./importance-reasons";

const reason = {
  id: "v1",
  userName: "Ada",
  agentName: "Ada's Claude",
  weight: 5,
  summary: "Blocks every signup.",
  description: "New users cannot finish signing up.",
  updatedAt: new Date("2026-10-30T12:00:00Z"),
};

describe("ImportanceReasons (#importance)", () => {
  it("renders nothing without reasons", () => {
    expect(renderToStaticMarkup(createElement(ImportanceReasons, { reasons: [] }))).toBe("");
  });

  it("lists who marked it, via which agent, with the summary and description", () => {
    const html = renderToStaticMarkup(createElement(ImportanceReasons, { reasons: [reason] }));
    expect(html).toContain("<details");
    expect(html).toContain("Why it&#x27;s important · 1 reason");
    expect(html).toContain("Ada");
    expect(html).toContain("via Ada&#x27;s Claude");
    expect(html).toContain("counts as 5");
    expect(html).toContain("Blocks every signup.");
    expect(html).toContain("New users cannot finish signing up.");
  });
});
