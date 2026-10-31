// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import AppForbidden from "./forbidden";

describe("in-app 403 page (#567)", () => {
  beforeEach(() => cleanup());

  it("adds no <main> of its own, so the layout's <main> stays the only one", () => {
    render(
      <main id="main-content">
        <AppForbidden />
      </main>,
    );
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("offers a way back to the issues", () => {
    render(<AppForbidden />);
    expect(screen.getByRole("link", { name: /issues/i })).toHaveAttribute("href", "/issues");
  });
});
