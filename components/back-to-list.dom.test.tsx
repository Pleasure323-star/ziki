// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ push: vi.fn(), pathname: "/issues", search: "status=open&page=2" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
// A plain anchor: the test is about BackToList's click handler, not Next's router.
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import { BackToList, RememberIssueList } from "./back-to-list";

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});
afterEach(() => cleanup());

describe("BackToList (#back-to-list)", () => {
  it("links to its fallback with an accessible label", () => {
    render(<BackToList fallback="/issues?status=open" label="Back to issues" />);
    const link = screen.getByRole("link", { name: "Back to issues" });
    expect(link).toHaveAttribute("href", "/issues?status=open");
  });

  it("returns to the list the person last had open, with its tab and filters", () => {
    render(<RememberIssueList />);
    cleanup();
    render(<BackToList fallback="/issues?status=in_progress" label="Back to issues" />);
    fireEvent.click(screen.getByRole("link", { name: "Back to issues" }));
    expect(mocks.push).toHaveBeenCalledWith("/issues?status=open&page=2");
  });

  it("follows the fallback when no list was remembered", () => {
    render(<BackToList fallback="/issues?status=open" label="Back to issues" />);
    const link = screen.getByRole("link", { name: "Back to issues" });
    let prevented: boolean | null = null;
    // Record whether BackToList took over, then stop jsdom's unimplemented navigation.
    const spy = (event: Event) => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", spy);
    fireEvent.click(link);
    document.removeEventListener("click", spy);
    expect(prevented).toBe(false);
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
