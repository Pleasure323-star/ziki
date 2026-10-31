// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/app/actions/issues", () => ({
  editBugContentAction: vi.fn(),
}));

vi.mock("@/components/markdown-editor", () => ({
  MarkdownEditor: () => null,
}));

import { EditableIssueDescription } from "./editable-issue-description";

afterEach(cleanup);

const base = {
  bugId: "bug_1",
  initialTitle: "Title",
  initialDescription: "Description body",
  canEdit: true,
  users: [],
};

describe("EditableIssueDescription heading row", () => {
  it("offers editing to people who can edit", () => {
    const { getByRole } = render(<EditableIssueDescription {...base} />);

    expect(getByRole("button", { name: "Edit description" })).toBeInTheDocument();
  });

  it("hides the edit button from people who can't edit", () => {
    const { queryByRole } = render(<EditableIssueDescription {...base} canEdit={false} />);

    expect(queryByRole("button", { name: "Edit description" })).toBeNull();
  });
});
