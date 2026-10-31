import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldBackfillOnStart, startPointsBackfill } from "./backfill-on-start";

const result = { bugs: 4, planned: 6, written: 2, existing: 4 };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("points backfill on server start", () => {
  it("runs for a production server and skips a build", () => {
    expect(shouldBackfillOnStart({ NODE_ENV: "production" })).toBe(true);
    expect(shouldBackfillOnStart({ NODE_ENV: "production", BACKFILL_POINTS_ON_START: "0" })).toBe(false);
    expect(shouldBackfillOnStart({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" })).toBe(false);
    expect(shouldBackfillOnStart({ NODE_ENV: "development" })).toBe(false);
    expect(shouldBackfillOnStart({ NODE_ENV: "development", BACKFILL_POINTS_ON_START: "1" })).toBe(true);
  });

  it("records how many awards were written", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const run = vi.fn(async () => result);
    startPointsBackfill(run);
    await vi.waitFor(() => expect(log.mock.calls.some((call) => String(call[0]).includes("2 written"))).toBe(true));
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps the server up when the backfill fails", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    startPointsBackfill(() => Promise.reject(new Error("ledger down")));
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
  });
});
