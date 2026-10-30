import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deliveryDeadline,
  deliveryWindowMinutes,
  extendDeadline,
  isDeliveryOverdue,
  isOwnerWaitOver,
  ownerWaitCapMinutes,
  remainingLabel,
  resumeAfterWait,
  DEFAULT_DELIVERY_WINDOW_MINUTES,
  DEFAULT_OWNER_WAIT_CAP_MINUTES,
} from "./claim-deadline";

const now = new Date("2026-10-19T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe("claim delivery deadline (#593)", () => {
  it("defaults to one 240-minute (4 hour) window for every issue", () => {
    expect(deliveryWindowMinutes()).toBe(DEFAULT_DELIVERY_WINDOW_MINUTES);
    expect(DEFAULT_DELIVERY_WINDOW_MINUTES).toBe(240);
    expect(deliveryWindowMinutes(null)).toBe(240);
  });

  it("takes the project's window as given, falling back to 240 when it is not positive", () => {
    expect(deliveryWindowMinutes(30)).toBe(30);
    expect(deliveryWindowMinutes(90)).toBe(90);
    expect(deliveryWindowMinutes(90.7)).toBe(90);
    expect(deliveryWindowMinutes(0)).toBe(240);
    expect(deliveryWindowMinutes(Number.NaN)).toBe(240);
  });

  it("counts the deadline from acceptance", () => {
    expect(deliveryDeadline(now, 15)).toEqual(new Date("2026-10-19T12:15:00.000Z"));
    expect(deliveryDeadline(now, 60)).toEqual(new Date("2026-10-19T13:00:00.000Z"));
  });

  it("adds the same window again from the current deadline, not from now", () => {
    const current = new Date("2026-10-19T12:10:00.000Z");
    vi.advanceTimersByTime(5 * 60_000);
    expect(extendDeadline(current, 15)).toEqual(new Date("2026-10-19T12:25:00.000Z"));
  });

  it("is overdue at the deadline and not one millisecond before", () => {
    const deadline = new Date("2026-10-19T12:15:00.000Z");
    expect(isDeliveryOverdue(deadline, new Date(deadline.getTime() - 1))).toBe(false);
    expect(isDeliveryOverdue(deadline, deadline)).toBe(true);
    expect(isDeliveryOverdue(null, now)).toBe(false);
  });

  it("labels the time left for the issue page", () => {
    expect(remainingLabel(new Date("2026-10-19T12:12:00.000Z"), now)).toBe("12m left");
    expect(remainingLabel(new Date("2026-10-19T13:05:00.000Z"), now)).toBe("1h 5m left");
    expect(remainingLabel(new Date("2026-10-19T13:00:00.000Z"), now)).toBe("1h left");
    expect(remainingLabel(new Date("2026-10-19T11:59:00.000Z"), now)).toBe("Overdue");
    expect(remainingLabel(null, now)).toBeNull();
  });
});

describe("owner waits (#606)", () => {
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  it("defaults the cap to four hours and takes a positive project value", () => {
    expect(ownerWaitCapMinutes()).toBe(DEFAULT_OWNER_WAIT_CAP_MINUTES);
    expect(DEFAULT_OWNER_WAIT_CAP_MINUTES).toBe(240);
    expect(ownerWaitCapMinutes(90)).toBe(90);
    expect(ownerWaitCapMinutes(0)).toBe(240);
    expect(ownerWaitCapMinutes(Number.NaN)).toBe(240);
  });

  it("ends the wait at the cap, not before", () => {
    expect(isOwnerWaitOver(minutesAgo(239), now, 240)).toBe(false);
    expect(isOwnerWaitOver(minutesAgo(240), now, 240)).toBe(true);
  });

  it("shifts a clock forward by the time spent waiting", () => {
    expect(resumeAfterWait(minutesAgo(5), minutesAgo(60), now)).toEqual(new Date(now.getTime() + 55 * 60_000));
    expect(resumeAfterWait(null, minutesAgo(60), now)).toBeNull();
  });
});
