import { describe, expect, it } from "vitest";
import { OPTIONS, PATCH } from "./route";

describe("unsupported methods on /api/v1/issues", () => {
  it("returns a JSON 405 and advertises the supported methods", async () => {
    const response = PATCH(
      new Request("https://ziki.dev/api/v1/issues", { method: "PATCH" }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      error: "method_not_allowed",
      message: "Method not allowed.",
    });
  });

  it("advertises only the methods the route supports", () => {
    const response = OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });
});
