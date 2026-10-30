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

  it("displays keyboard shortcut hint in placeholder and kbd badge", async () => {
    search.params = new URLSearchParams("");
    const { IssueFilters } = await import("./issue-filters");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");

    const html = renderToStaticMarkup(createElement(IssueFilters));
    // Since the #1299 reskin the hint is the "/" key badge, not placeholder text.
    expect(html).toContain('placeholder="Search, or type a tag like Design"');
    expect(html).toMatch(/<kbd[^>]*>\/<\/kbd>/);
  });

  it("omits keyboard shortcut hint and badge when shortcutsEnabled is false (#727)", async () => {
    search.params = new URLSearchParams("");
    const { IssueFilters } = await import("./issue-filters");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");

    const html = renderToStaticMarkup(createElement(IssueFilters, { shortcutsEnabled: false }));
    expect(html).toContain('placeholder="Search, or type a tag like Design"');
    expect(html).not.toContain('(/)');
    expect(html).not.toContain("<kbd");
  });

  it("handles keyboard shortcut listener properly in source code", async () => {
    const { readFileSync } = await import("fs");
    const source = readFileSync("components/issue-filters.tsx", "utf8");

    expect(source).toContain('window.addEventListener("keydown", handleKeyDown)');
    expect(source).toContain('window.removeEventListener("keydown", handleKeyDown)');
    expect(source).toContain('if (!shortcutsEnabled) return;');
    expect(source).toContain("isTypingTarget(target)");
    expect(source).toContain("inDialog");
    expect(source).toContain('event.key === "/"');
    expect(source).toContain('event.key.toLowerCase() === "k"');
    expect(source).toContain("event.isComposing");
    expect(source).toContain("isSlash && isEditable");
    expect(source).toContain("inputRef.current?.focus()");
    expect(source).toContain("inputRef.current?.select()");
  });
});

describe("IssueFilters live search (#671)", () => {
  it("debounces the list update and fetches issue suggestions", async () => {
    const { readFileSync } = await import("fs");
    const source = readFileSync("components/issue-filters.tsx", "utf8");

    expect(source).toContain("SEARCH_DEBOUNCE_MS");
    expect(source).toContain("if (livePushedRef.current) router.replace(href)");
    expect(source).toContain("router.push(href)");
    expect(source).toContain("/api/issues/suggest");
    expect(source).toContain("pickSuggestion");
  });
});

describe("IssueFilters search commit + feedback (#690)", () => {
  it("wires a busy state, an explicit Search button, and no blur commit", async () => {
    const { readFileSync } = await import("fs");
    const source = readFileSync("components/issue-filters.tsx", "utf8");

    // Busy state comes from a navigation transition around the router calls.
    expect(source).toContain("useTransition");
    expect(source).toContain("aria-busy={isSearching}");

    // An explicit Search button commits the query.
    expect(source).toContain("onClick={applyQueryNow}");

    // Blurring the box closes the dropdown but must not commit the search.
    const blurBody = source.match(/onBlur=\{\(\) => \{([\s\S]*?)\}\}/)?.[1] ?? "";
    expect(blurBody).toContain("setOpen(false)");
    expect(blurBody).not.toContain("applyQueryNow");
  });

  it("announces the result count as a live region on the list page (#690)", async () => {
    const { readFileSync } = await import("fs");
    const source = readFileSync("app/(app)/issues/(list)/page.tsx", "utf8");
    expect(source).toMatch(/role="status" aria-live="polite"[\s\S]*?resultCountText/);
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
    expect(html).toContain("Area: Frontend");
    expect(html).toContain('aria-label="Remove area filter"');
  });
});
