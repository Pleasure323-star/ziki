import { afterEach, describe, expect, it, vi } from "vitest";
import * as diagnostics from "./auth-diagnostics";
import { describeAuthError, recordAuthError } from "./auth-diagnostics";

afterEach(() => vi.restoreAllMocks());

describe("describeAuthError", () => {
  it("prefers the wrapped cause over the generic message", () => {
    const error = Object.assign(new Error("Configuration"), {
      type: "CallbackRouteError",
      cause: { err: new Error("connect ECONNREFUSED db:5432") },
    });
    expect(describeAuthError(error)).toEqual({
      type: "CallbackRouteError",
      detail: "connect ECONNREFUSED db:5432",
    });
  });

  it("falls back to a generic detail", () => {
    expect(describeAuthError({}).detail).toMatch(/\S/);
  });
});

describe("recordAuthError", () => {
  it("only logs, and exposes no way to read the error back (#118)", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    recordAuthError(new Error("secret detail"));
    expect(log).toHaveBeenCalledOnce();
    expect(Object.keys(diagnostics).sort()).toEqual(["describeAuthError", "recordAuthError"]);
  });

  it("redacts sensitive data in error message", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    recordAuthError(new Error("failed postgresql://user:supersecretpass@db:5432/main"));
    expect(log).toHaveBeenCalledWith(
      "[auth:diagnostic] Captured auth error:",
      expect.objectContaining({
        detail: "failed postgresql://user:[REDACTED]@db:5432/main",
      }),
    );
  });
});
