import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PointsLedger } from "./points-ledger";

describe("PointsLedger (#461)", () => {
  it("renders signed corrections, accessible table headings and preserves filters while paging", () => {
    const html = renderToStaticMarkup(<PointsLedger profileId="owner" from="2026-10-01" to="2026-10-22" page={{
      items: [{ id: "one", role: "reporter", points: -5, source: "Correction", createdAt: "2026-10-22T00:00:00Z", issue: null, idea: null },
        { id: "two", role: "solver", points: 25, source: "Solver award", createdAt: "2026-10-22T00:00:00Z", issue: { id: "issue", number: 7, title: "Example", path: "/ziki/7" }, idea: null }], nextCursor: "next",
    }} />);
    expect(html).toContain("-5"); expect(html).toContain("+25"); expect(html).toContain("Correction");
    expect(html).toContain('scope="col"'); expect(html).toContain('href="/ziki/7"');
    expect(html).toContain("from=2026-10-01&amp;to=2026-10-22&amp;cursor=next");
  });
  it("shows an alert for an invalid query", () => {
    expect(renderToStaticMarkup(<PointsLedger page={null} profileId="owner" error />)).toContain('role="alert"');
  });
});
