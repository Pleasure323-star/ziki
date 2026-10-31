import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownEditor } from "./markdown-editor";

describe("MarkdownEditor accessibility (#146)", () => {
  it("puts the combobox semantics on the wrapper, not the textarea (#AXE)", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownEditor, {
        value: "Hello world",
        onChange: () => {},
        users: [{ id: "u1", name: "Ada" }],
      }),
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-expanded="false"');

    // ARIA does not allow role="combobox" on a textarea; axe reports it as
    // aria-allowed-role and the role is ignored. It belongs on the wrapper.
    const textarea = html.slice(html.indexOf("<textarea"));
    expect(textarea).not.toContain('role="combobox"');
    expect(textarea).not.toContain("aria-expanded");
    // The field keeps what belongs to the text field itself.
    expect(textarea).toContain('aria-autocomplete="list"');
  });

  it("does not render role='combobox' or aria-expanded when mentions are disabled", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownEditor, {
        value: "Hello world",
        onChange: () => {},
        users: [],
      }),
    );
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain('aria-autocomplete="list"');
  });

});

describe("MarkdownEditor form validation (#123)", () => {
  it("renders required and minLength attributes on the textarea", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownEditor, {
        value: "",
        onChange: () => {},
        required: true,
        minLength: 10,
        name: "description",
      }),
    );
    expect(html).toContain("required");
    expect(html).toContain('minLength="10"');
    expect(html).toContain('name="description"');
  });
});

describe("the mention wrapper has a name of its own", () => {
  it("borrows aria-label when the field is named that way", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownEditor, {
        value: "",
        onChange: () => {},
        users: [{ id: "u1", name: "Ada" }],
        "aria-label": "Edit comment",
      }),
    );
    // Both the wrapper and the field carry it: the wrapper is the combobox,
    // the textarea is still the text field.
    expect(html.match(/aria-label="Edit comment"/g)).toHaveLength(2);
  });

  it("points at the visible label when one is given", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownEditor, {
        value: "",
        onChange: () => {},
        users: [{ id: "u1", name: "Ada" }],
        labelId: "body-label",
      }),
    );
    expect(html).toContain('aria-labelledby="body-label"');
  });

  it("adds neither when there are no mentions, since there is no combobox", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownEditor, {
        value: "",
        onChange: () => {},
        users: [],
        labelId: "body-label",
      }),
    );
    expect(html).not.toContain("aria-labelledby");
  });
});
