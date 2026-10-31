import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { highlightSegments, matchSnippet } from "@/lib/search-snippet";
import { Highlighted, SearchSnippet } from "./search-highlight";

describe("Highlighted", () => {
  it("wraps matches in <mark> and escapes stored HTML", () => {
    const html = renderToStaticMarkup(
      createElement(Highlighted, {
        segments: highlightSegments("<script>alert(1)</script> crash", "crash"),
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toMatch(/<mark[^>]*>crash<\/mark>/);
  });
});

describe("SearchSnippet", () => {
  it("shows ellipses where the snippet is cut", () => {
    const snippet = matchSnippet(
      "a long description where the word export appears somewhere in the middle of it all",
      "export",
      10,
    )!;
    const html = renderToStaticMarkup(createElement(SearchSnippet, { snippet }));
    expect(html.match(/…/g)).toHaveLength(2);
    expect(html).toMatch(/<mark[^>]*>export<\/mark>/);
  });
});
