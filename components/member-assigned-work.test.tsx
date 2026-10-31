import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The level control's server action pulls in next-auth, which can't load here.
vi.mock("@/components/team-agent-level", () => ({ TeamAgentLevelControl: () => null }));
import { MemberAssignedWork, issueCount } from "./member-assigned-work";
import { TeamAgentList } from "./team-agent-list";

const work = (id: string) => ({ id, path: `/ziki/${id}`, title: `Issue ${id}`, categoryId: null, categoryName: "Web", areaId: null, areaName: null });

describe("MemberAssignedWork (Ziki #447)", () => {
  it("renders nothing without assigned work", () => {
    expect(renderToStaticMarkup(<MemberAssignedWork work={[]} />)).toBe("");
  });

  it("shows the count and links each issue", () => {
    const html = renderToStaticMarkup(<MemberAssignedWork work={[work("a"), work("b")]} />);
    expect(html).toContain("(2)");
    expect(html).toContain('href="/ziki/a"');
    expect(html).toContain('href="/ziki/b"');
    expect(html).toContain("Web");
  });

  it("says 1 issue or N issues", () => {
    expect(issueCount(1)).toBe("1 issue");
    expect(issueCount(3)).toBe("3 issues");
  });

  it("puts the count on an agent's Current work heading", () => {
    const agent = { id: "a1", name: "Ada's agent", model: null, level: "working" as const, online: true, acceptedFixes: 0, currentWork: [work("x"), work("y")] };
    const html = renderToStaticMarkup(<TeamAgentList agents={[agent]} />);
    expect(html).toContain("(2)");
    expect(html).toContain('href="/ziki/x"');
  });
});
