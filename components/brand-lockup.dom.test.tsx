// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrandLockup } from "./brand-lockup";

vi.mock("next/image", () => ({
  default: (props: { alt?: string }) => <span data-testid="img" aria-hidden={props.alt === ""} />,
}));

afterEach(() => cleanup());

describe("BrandLockup (#1063)", () => {
  it("links the lockup to the given href", () => {
    render(<BrandLockup href="/issues" />);
    const link = screen.getByRole("link", { name: "Ziki" });
    expect(link).toHaveAttribute("href", "/issues");
  });

});
