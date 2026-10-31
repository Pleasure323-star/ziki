import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Icon-only controls and their states must not depend on sight (#315).
 * Rendered server-side, so this checks the markup a screen reader actually
 * gets, not a component's props.
 */

vi.mock("@/app/actions/issues", () => ({
  toggleBoostBugAction: vi.fn(),
  voteBugAction: vi.fn(),
}));
vi.mock("@/components/ui/toast", () => ({ useToast: () => () => {} }));

import { BoostTicketButton } from "./boost-ticket-button";

/** The accessible name a <button> gets from aria-label or its own text. */
function buttonNames(html: string): string[] {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, inner]) => {
    const label = /aria-label="([^"]*)"/.exec(attrs)?.[1];
    const text = inner.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim();
    return (label ?? text).trim();
  });
}

describe("BoostTicketButton", () => {
  it.each([true, false])("has a real name with showLabel=%s, not just a title", (showLabel) => {
    const html = renderToStaticMarkup(
      createElement(BoostTicketButton, { bugId: "b1", isBoosted: false, showLabel }),
    );
    const names = buttonNames(html);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/boost/i);
  });

  it("exposes the boosted state, which otherwise only the fill shows", () => {
    const on = renderToStaticMarkup(createElement(BoostTicketButton, { bugId: "b1", isBoosted: true }));
    const off = renderToStaticMarkup(createElement(BoostTicketButton, { bugId: "b1", isBoosted: false }));
    expect(on).toContain('aria-pressed="true"');
    expect(off).toContain('aria-pressed="false"');
  });
});
