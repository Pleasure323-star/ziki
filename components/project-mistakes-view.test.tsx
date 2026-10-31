// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectMistakesView, type ProjectMistakeItem } from "./project-mistakes-view";

afterEach(() => cleanup());

const mockMistakes: ProjectMistakeItem[] = [
  {
    id: "m1",
    projectId: "proj-1",
    category: "correctness",
    title: "Unchecked null property access",
    antiPattern: "Accessing deep object properties without optional chaining.",
    remediation: "Use optional chaining (?.) or assert non-null with runtime guards.",
    badCodeSnippet: "const name = user.profile.name;",
    goodCodeSnippet: "const name = user?.profile?.name ?? 'Unknown';",
    recurrenceCount: 3,
    createdAt: new Date().toISOString(),
  },
  {
    id: "m2",
    projectId: "proj-1",
    category: "security",
    title: "SQL injection in raw query",
    antiPattern: "Interpolating raw strings into SQL statements.",
    remediation: "Always use parameterized Prisma / SQL queries.",
    recurrenceCount: 1,
    createdAt: new Date().toISOString(),
  },
];

describe("ProjectMistakesView", () => {
  it("renders mistake items with details and recurrence badges", () => {
    const { getByText, getAllByTestId } = render(<ProjectMistakesView mistakes={mockMistakes} />);
    
    expect(getAllByTestId("mistake-item")).toHaveLength(2);
    expect(getByText("Unchecked null property access")).toBeInTheDocument();
    expect(getByText(/\b3x?\b/)).toBeInTheDocument();
    expect(getByText("const name = user.profile.name;")).toBeInTheDocument();
    expect(getByText("const name = user?.profile?.name ?? 'Unknown';")).toBeInTheDocument();
    expect(getByText("SQL injection in raw query")).toBeInTheDocument();
  });

  it("filters mistakes when category buttons are clicked", () => {
    const { getByRole, getAllByTestId, queryByText } = render(
      <ProjectMistakesView mistakes={mockMistakes} />,
    );

    // Initial state: 2 items
    expect(getAllByTestId("mistake-item")).toHaveLength(2);

    // Click "Security"
    fireEvent.click(getByRole("button", { name: "Security" }));
    expect(getAllByTestId("mistake-item")).toHaveLength(1);
    expect(queryByText("Unchecked null property access")).not.toBeInTheDocument();
    expect(queryByText("SQL injection in raw query")).toBeInTheDocument();

    // Click "All Categories"
    fireEvent.click(getByRole("button", { name: "All Categories" }));
    expect(getAllByTestId("mistake-item")).toHaveLength(2);
  });
});
