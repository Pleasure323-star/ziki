import { describe, expect, it } from "vitest";
import {
  addUtcDays,
  buildPointsSeries,
  captionFor,
  defaultWindow,
  pointsThisWeek,
  startOfIsoWeek,
  startOfUtcDay,
  sumPointsInRange,
} from "./history";

const entry = (iso: string, points: number) => ({
  createdAt: new Date(iso),
  points,
});

describe("points history buckets", () => {
  const now = new Date("2026-10-22T15:00:00Z");

  it("starts ISO weeks on Monday UTC", () => {
    expect(startOfIsoWeek(now).toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(startOfIsoWeek(new Date("2026-10-18T12:00:00Z")).toISOString()).toBe(
      "2026-10-12T00:00:00.000Z",
    );
  });

  it("builds seven daily buckets for the default window", () => {
    const series = buildPointsSeries({
      entries: [
        entry("2026-10-16T10:00:00Z", 40),
        entry("2026-10-17T10:00:00Z", 90),
        entry("2026-10-20T10:00:00Z", 110),
        entry("2026-10-22T10:00:00Z", 30),
      ],
      granularity: "daily",
      now,
    });
    expect(series.buckets).toHaveLength(7);
    expect(series.buckets[0]?.label).toBe("16 Oct");
    expect(series.buckets[0]?.points).toBe(40);
    expect(series.buckets[1]?.points).toBe(90);
    expect(series.buckets[2]?.points).toBe(0);
    expect(series.buckets[4]?.points).toBe(110);
    expect(series.buckets[6]?.points).toBe(30);
    expect(series.total).toBe(270);
    expect(series.target).toBe(0);
    expect(series.caption).toBe(captionFor("daily"));
  });

  it("marks weekly series with a 500 target and sums each week", () => {
    const series = buildPointsSeries({
      entries: [
        entry("2026-10-06T10:00:00Z", 300),
        entry("2026-10-07T10:00:00Z", 380),
        entry("2026-10-13T10:00:00Z", 520),
        entry("2026-10-20T10:00:00Z", 450),
      ],
      granularity: "weekly",
      now,
    });
    expect(series.target).toBe(500);
    expect(series.buckets.length).toBe(8);
    const week5 = series.buckets.find((b) => b.label === "5 Oct");
    const week12 = series.buckets.find((b) => b.label === "12 Oct");
    const week19 = series.buckets.find((b) => b.label === "19 Oct");
    expect(week5?.points).toBe(680);
    expect(week12?.points).toBe(520);
    expect(week19?.points).toBe(450);
  });

  it("filters buckets by an explicit from/to date range", () => {
    const series = buildPointsSeries({
      entries: [
        entry("2026-10-01T10:00:00Z", 10),
        entry("2026-10-10T10:00:00Z", 20),
        entry("2026-10-20T10:00:00Z", 30),
      ],
      granularity: "daily",
      from: new Date("2026-10-10T00:00:00Z"),
      to: new Date("2026-10-12T00:00:00Z"),
      now,
    });
    expect(series.buckets.map((b) => b.label)).toEqual(["10 Oct", "11 Oct", "12 Oct"]);
    expect(series.total).toBe(20);
  });

  it("sums points this ISO week", () => {
    const entries = [
      entry("2026-10-18T10:00:00Z", 100),
      entry("2026-10-19T10:00:00Z", 200),
      entry("2026-10-22T10:00:00Z", 50),
    ];
    expect(pointsThisWeek(entries, now)).toBe(250);
  });

  it("sumPointsInRange is half-open on the end", () => {
    const from = startOfUtcDay(new Date("2026-10-01T00:00:00Z"));
    const to = addUtcDays(from, 1);
    expect(
      sumPointsInRange(
        [entry("2026-10-01T00:00:00Z", 5), entry("2026-10-02T00:00:00Z", 9)],
        from,
        to,
      ),
    ).toBe(5);
  });

  it("default windows match the mockup lengths", () => {
    expect(defaultWindow("daily", now).from.toISOString()).toBe("2026-10-16T00:00:00.000Z");
    expect(defaultWindow("weekly", now).from.toISOString()).toBe("2026-08-31T00:00:00.000Z");
    expect(defaultWindow("monthly", now).from.toISOString()).toBe("2025-11-01T00:00:00.000Z");
    expect(defaultWindow("yearly", now).from.toISOString()).toBe("2022-01-01T00:00:00.000Z");
  });
});
