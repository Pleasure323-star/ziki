// @vitest-environment jsdom
"use client";

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CategoryManager } from "./category-manager";

vi.mock("@/app/actions/categories", () => ({
  createCategoryAction: vi.fn(),
  updateCategoryAction: vi.fn(),
  toggleCategoryStatusAction: vi.fn(),
  deleteCategoryAction: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const categories = [
  {
    id: "cat-1",
    name: "Backend Services, APIs and Integrations",
    isActive: true,
    createdAt: new Date("2026-01-01"),
    _count: { bugs: 12 },
  },
];

describe("CategoryManager row (#694)", () => {
  it("still renders the count and all three actions for a row", () => {
    render(<CategoryManager initialCategories={categories} />);
    expect(screen.getByText(/\b12\b/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });
});
