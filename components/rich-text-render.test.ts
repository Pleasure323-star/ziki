import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RichText } from "./rich-text";

const render = (content: string) =>
  renderToStaticMarkup(createElement(RichText, { content }));

describe("RichText shows tag-like text (#116)", () => {
  it("keeps <Button> and List<String> in plain text", () => {
    const html = render("The <Button> component crashes when List<String> is empty.");
    expect(html).toContain("The &lt;Button&gt; component crashes when List&lt;String&gt; is empty.");
  });

  it("keeps tags inside inline code and fenced code", () => {
    const html = render("Crash when `List<String>` is empty\n\n```tsx\n<Provider store={store}>\n```");
    expect(html).toContain("<code>List&lt;String&gt;</code>");
    expect(html).toContain("&lt;Provider store={store}&gt;");
  });

  it("escapes markup instead of rendering it", () => {
    const html = render('**x** <img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("RichText ordered list start attribute (#137)", () => {
  it('renders <ol start="3"> when list starts at 3', () => {
    const html = render("3. third step\n4. fourth step");
    expect(html).toContain('<ol start="3">');
    expect(html).toContain("third step");
    expect(html).toContain("fourth step");
  });

  it("renders standard ordered list when starting at 1", () => {
    const html = render("1. first step\n2. second step");
    expect(html).toContain("<ol");
    expect(html).toContain("first step");
  });
});

describe("RichText adjacent mixed-marker lists (#725)", () => {
  // Inline text is wrapped in bare <span>s; drop them to compare list structure.
  const renderLists = (content: string) => render(content).replace(/<\/?span>/g, "");

  it("renders an ordered item followed by a bullet as ol then ul", () => {
    const html = renderLists("1. first\n- second");
    expect(html).toContain("<ol start=\"1\"><li>first</li></ol><ul><li>second</li></ul>");
  });

  it("renders a bullet followed by an ordered item as ul then ol", () => {
    const html = renderLists("- first\n1. second");
    expect(html).toContain("<ul><li>first</li></ul><ol start=\"1\"><li>second</li></ol>");
  });

  it("splits mixed markers inside nested lists too", () => {
    const html = renderLists("- parent\n  1. one\n  - two");
    expect(html).toContain("<li>parent<ol start=\"1\"><li>one</li></ol><ul><li>two</li></ul></li>");
  });

  it("keeps a same-marker run as a single list", () => {
    const html = render("- a\n- b\n- c");
    expect(html.match(/<ul>/g)).toHaveLength(1);
    expect(html).not.toContain("<ol");
  });
});

describe("RichText nested inline formatting (#136)", () => {
  it("renders mentions inside bold, italic, and strikethrough", () => {
    const mockRenderMentions = (text: string) => {
      return text.replace(/@\[([^\]]+)\]\(([^)]+)\)/g, '<span class="mention">@$1</span>');
    };
    const html = renderToStaticMarkup(
      createElement(RichText, {
        content: "**Ask @[Alice Mentor](user1) to check** and *ping @[Bob](user2)* or ~~@[Charlie](user3)~~",
        renderMentions: (text) => createElement("span", {
          dangerouslySetInnerHTML: { __html: mockRenderMentions(text) }
        }),
      }),
    );

    expect(html).toMatch(/<strong>(?:(?!<\/strong>).)*class="mention">@Alice Mentor<(?:(?!<\/strong>).)*<\/strong>/);
    expect(html).toMatch(/<em>(?:(?!<\/em>).)*class="mention">@Bob<(?:(?!<\/em>).)*<\/em>/);
    expect(html).toMatch(/<del>(?:(?!<\/del>).)*class="mention">@Charlie<(?:(?!<\/del>).)*<\/del>/);
  });

  it("renders links inside bold text", () => {
    const html = render("**[the docs](https://example.com/docs)**");
    expect(html).toContain('<strong><a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">the docs</a></strong>');
  });

  it("renders italic inside bold text", () => {
    const html = render("**bold and _italic_**");
    expect(html).toMatch(/<strong>(?:(?!<\/strong>).)*<em>(?:(?!<\/em>).)*italic(?:(?!<\/em>).)*<\/em>(?:(?!<\/strong>).)*<\/strong>/);
  });
});

describe("RichText fenced code delimiters (#723)", () => {
  it("keeps a shorter inner fence inside a four-backtick block", () => {
    const html = render("````md\n```js\nconst a = 1;\n```\n````\n\nAfter the block");
    expect(html.match(/<pre/g)).toHaveLength(1);
    expect(html).toContain("<code>```js\nconst a = 1;\n```</code>");
    expect(html.indexOf("After the block")).toBeGreaterThan(html.indexOf("</pre>"));
  });

  it("renders tilde-fenced code as a code block", () => {
    const html = render("~~~js\nconst x = **1**;\n~~~");
    expect(html).toContain("<code>const x = **1**;</code>");
    expect(html).not.toContain("<strong>");
  });

  it("does not close a backtick fence with a tilde fence", () => {
    const html = render("```\n~~~\nstill code\n```");
    expect(html).toContain("<code>~~~\nstill code</code>");
  });

  it("does not close a fence on a line with an info string", () => {
    const html = render("```\n```js\nstill code\n```");
    expect(html).toContain("<code>```js\nstill code</code>");
  });
});
