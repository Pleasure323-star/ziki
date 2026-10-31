// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pathname: "/", search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import { IssueSignInLink } from "./issue-sign-in-link";

afterEach(cleanup);

function signInHref(pathname: string, search = ""): string | null {
  mocks.pathname = pathname;
  mocks.search = search;
  render(<IssueSignInLink />);
  return screen.getByRole("link").getAttribute("href");
}

describe("IssueSignInLink (#457, #project-urls)", () => {
  it("returns to the project issue address after sign-in, keeping the query", () => {
    expect(signInHref("/ziki/345", "comment=c9")).toBe(
      `/login?callbackUrl=${encodeURIComponent("/ziki/345?comment=c9")}`,
    );
  });

  it("returns to an issue's history page", () => {
    expect(signInHref("/ziki/345/history")).toBe(`/login?callbackUrl=${encodeURIComponent("/ziki/345/history")}`);
  });

  it("returns to an old /issues address", () => {
    expect(signInHref("/issues/12")).toBe(`/login?callbackUrl=${encodeURIComponent("/issues/12")}`);
  });

  it("does not use other addresses as the return path", () => {
    expect(signInHref("/settings/12")).toBe("/login");
  });
});
