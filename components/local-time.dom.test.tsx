// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { LocalTime, getClientTimeZone, getServerTimeZone } from "./local-time";
import * as formatModule from "@/lib/format";

describe("LocalTime", () => {
  const sampleUtc = new Date("2026-10-15T18:30:00Z");

  it("getServerTimeZone returns the default server timezone", () => {
    expect(getServerTimeZone()).toBe(formatModule.getDefaultTimeZone());
  });

  it("getClientTimeZone returns browser timezone or falls back to default", () => {
    const tz = getClientTimeZone();
    expect(typeof tz).toBe("string");
    expect(tz.length).toBeGreaterThan(0);
  });

  it("renders on the server matching the server timezone format without suppressHydrationWarning", () => {
    const html = renderToString(<LocalTime date={sampleUtc} className="custom-class" />);
    // Africa/Lagos (UTC+1) is 7:30 PM for 18:30 UTC
    expect(html).toContain("Oct 15, 2026, 7:30 PM");
    expect(html).toContain('dateTime="2026-10-15T18:30:00.000Z"');
    expect(html).toContain('class="custom-class"');
    expect(html).not.toContain("suppressHydrationWarning");
    expect(html).not.toContain("suppresshydrationwarning");
  });

  it("shows the humanized time, with the full stamp in the client's timezone as its tooltip", () => {
    vi.useFakeTimers({ now: new Date("2026-10-15T20:30:00Z"), toFake: ["Date"] });
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "America/New_York",
      locale: "en-US",
      calendar: "gregory",
      numberingSystem: "latn",
    } as unknown as Intl.ResolvedDateTimeFormatOptions);

    try {
      const { container } = render(<LocalTime date={sampleUtc} />);
      const timeEl = container.querySelector("time");
      expect(timeEl).not.toBeNull();
      expect(timeEl?.textContent).toBe("2 hours ago");
      expect(timeEl?.getAttribute("datetime")).toBe("2026-10-15T18:30:00.000Z");
      // In America/New_York (UTC-4 in Oct), 18:30 UTC is 2:30 PM
      expect(timeEl?.getAttribute("title")).toBe("Oct 15, 2026, 2:30 PM (America/New_York)");
      expect(timeEl?.getAttribute("suppresshydrationwarning")).toBeNull();
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("handles string dates", () => {
    const { container } = render(<LocalTime date="2026-10-15T18:30:00Z" />);
    const timeEl = container.querySelector("time");
    expect(timeEl?.getAttribute("datetime")).toBe("2026-10-15T18:30:00Z");
  });
});
