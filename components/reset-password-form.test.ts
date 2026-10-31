import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { vi } from "vitest";

vi.mock("next/navigation", () => ({
  unstable_rethrow: vi.fn(),
}));

vi.mock("@/app/actions/auth", () => ({
  resetPasswordAction: vi.fn(),
}));

import { ResetPasswordForm } from "./reset-password-form";

describe("ResetPasswordForm client validation (#359)", () => {
  it("renders password and confirm password inputs", () => {
    const html = renderToStaticMarkup(
      createElement(ResetPasswordForm, { token: "sample-token-123" }),
    );

    expect(html).toContain('id="password"');
    expect(html).toContain('id="confirmPassword"');
    expect(html).toContain('minLength="8"');
  });
});
