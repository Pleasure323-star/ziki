// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./page";

vi.mock("@/lib/auth-mode", () => ({
  isPasswordAuthEnabled: () => false,
}));

vi.mock("@/lib/google-oauth", () => ({
  isGoogleOAuthConfigured: () => true,
}));

vi.mock("@/app/actions/auth", () => ({
  googleSignInAction: vi.fn(),
  loginAction: vi.fn(),
}));

// Auth split frame mounts ThemeToggle; keep the page unit test free of
// settings/auth action side effects and next/image in jsdom.
vi.mock("@/components/theme-toggle", () => ({
  ThemeToggle: () =>
    createElement("button", {
      type: "button",
      "aria-label": "Switch to dark mode",
      "data-testid": "theme-toggle",
    }),
}));

vi.mock("next/image", () => ({
  default: (props: { alt?: string }) => createElement("img", { alt: props.alt ?? "" }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LoginPage OAuth error a11y (#653)", () => {
  it("announces OAuth failure with role='alert', aria-live='assertive' and aria-atomic='true'", async () => {
    const element = await LoginPage({
      searchParams: Promise.resolve({ error: "OAuthCallbackError" }),
    });
    render(element);

    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveAttribute("aria-atomic", "true");
  });

  it("announces a Configuration error", async () => {
    const element = await LoginPage({
      searchParams: Promise.resolve({ error: "Configuration" }),
    });
    render(element);

    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("tells a two-factor account to use email and the code instead of Google", async () => {
    const element = await LoginPage({
      searchParams: Promise.resolve({ error: "TwoFactor" }),
    });
    render(element);

    expect(screen.getByRole("alert")).toHaveTextContent(/code/i);
  });

  it("announces generic authentication error for other error codes", async () => {
    const element = await LoginPage({
      searchParams: Promise.resolve({ error: "CredentialsSignin" }),
    });
    render(element);

    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
  });

  it("never renders ?reason= text, so a crafted link cannot put words in the alert (#118, #558)", async () => {
    const element = await LoginPage({
      searchParams: Promise.resolve({
        error: "OAuthCallbackError",
        reason: "Your account is locked. Call +1 555 0100 to unlock it.",
      } as { error: string }),
    });
    render(element);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).not.toContain("locked");
    expect(alert.textContent).not.toContain("Diagnostic");
  });

  it("renders no alert when there is no error", async () => {
    const element = await LoginPage({
      searchParams: Promise.resolve({}),
    });
    render(element);

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders expired session status when expired parameter is present without error", async () => {
    const element = await LoginPage({
      searchParams: Promise.resolve({ expired: "1" }),
    });
    render(element);

    expect(screen.queryByRole("alert")).toBeNull();
    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
  });
});
