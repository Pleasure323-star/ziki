import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssigneeCombobox } from "./assignee-combobox";

describe("AssigneeCombobox ARIA accessibility (#358)", () => {
  const people = [
    { id: "u1", name: "Ada Lovelace", role: "admin" as const },
    { id: "u2", name: "Bob Smith", role: "user" as const },
  ];

  it("renders with full WAI-ARIA 1.2 Combobox attributes on the input", () => {
    const html = renderToStaticMarkup(
      createElement(AssigneeCombobox, {
        id: "assigneeId",
        name: "assigneeId",
        people,
        value: "u1",
      }),
    );

    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Assignee"');
  });

  it("supports custom aria-label override", () => {
    const html = renderToStaticMarkup(
      createElement(AssigneeCombobox, {
        id: "assigneeId",
        name: "assigneeId",
        people,
        "aria-label": "Select issue assignee",
      }),
    );

    expect(html).toContain('aria-label="Select issue assignee"');
  });

  it("supports aria-labelledby override", () => {
    const html = renderToStaticMarkup(
      createElement(AssigneeCombobox, {
        id: "assigneeId",
        name: "assigneeId",
        people,
        "aria-labelledby": "assignee-label-id",
      }),
    );

    expect(html).toContain('aria-labelledby="assignee-label-id"');
    expect(html).not.toContain('aria-label="Assignee"');
  });

  it("does not render aria-controls when combobox listbox is closed", () => {
    const html = renderToStaticMarkup(
      createElement(AssigneeCombobox, {
        id: "assigneeId",
        name: "assigneeId",
        people,
        value: "",
      }),
    );

    expect(html).not.toContain("aria-controls");
  });
});
