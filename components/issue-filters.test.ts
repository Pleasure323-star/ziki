import { describe, expect, it, vi } from "vitest";

const search = vi.hoisted(() => ({
  params: new URLSearchParams("page=2&q=crash"),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => search.params,
}));

/** Render the bar against a given query string. */
async function renderFilters(params: string, areas: { id: string; name: string }[] = []) {
  search.params = new URLSearchParams(params);
  const { IssueFilters } = await import("./issue-filters");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");

  return renderToStaticMarkup(createElement(IssueFilters, { areas }));
}

describe("IssueFilters (#132, #361)", () => {
  it("renders correctly with search param default value", async () => {
    const html = await renderFilters("page=2&q=crash");
    expect(html).toContain('value="crash"');
  });

  it("shows the / shortcut badge only when shortcuts are enabled (#727)", async () => {
    search.params = new URLSearchParams("");
    const { IssueFilters } = await import("./issue-filters");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");

    expect(renderToStaticMarkup(createElement(IssueFilters))).toMatch(/<kbd[^>]*>\/<\/kbd>/);
    expect(renderToStaticMarkup(createElement(IssueFilters, { shortcutsEnabled: false }))).not.toContain("<kbd");
  });
});

describe("IssueFilters clear all filters (#336)", () => {
  it("shows the button when a filter is set", async () => {
    const html = await renderFilters("page=2&q=crash");
    expect(html).toContain("Clear all filters");
  });

  it("shows the button for every filter param", async () => {
    for (const params of [
      "q=crash",
      "tags=Design",
      "mine=assigned",
      "status=open",
      "platform=none",
      "area=area-web",
      "milestone=m1",
      "milestone=none",
      "sort=oldest",
    ]) {
      const html = await renderFilters(params);
      expect(html, params).toContain("Clear all filters");
    }
  });

  it("has no severity filter, so a severity param offers nothing to clear", async () => {
    const html = await renderFilters("severity=high");
    expect(html).not.toContain("Clear all filters");
    expect(html).not.toMatch(/severity/i);
  });

  it("hides the button when only paging is set", async () => {
    const html = await renderFilters("page=2");
    expect(html).not.toContain("Clear all filters");
  });

  it("hides the button when a filter param is present but empty", async () => {
    const html = await renderFilters("q=&tags=&status=&milestone=");
    expect(html).not.toContain("Clear all filters");
  });

  it("shows the selected project area and a removable active-filter chip", async () => {
    const html = await renderFilters("area=area-web", [{ id: "area-web", name: "Frontend" }]);
    expect(html).toContain("Frontend");
    expect(html).toContain('aria-label="Remove area filter"');
  });
});
