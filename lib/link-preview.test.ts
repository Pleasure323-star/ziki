import { describe, expect, it } from "vitest";
import {
  bugLinkPreviewDescription,
  isLinkPreviewBot,
  snippetText,
} from "./link-preview";

describe("snippetText", () => {
  it("returns short text unchanged", () => {
    expect(snippetText("hello world")).toBe("hello world");
  });

  it("truncates long text with an ellipsis", () => {
    const long = "a".repeat(200);
    const result = snippetText(long, 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result.endsWith("…")).toBe(true);
  });

  it("collapses whitespace", () => {
    expect(snippetText("foo\n\n  bar")).toBe("foo bar");
  });
});

describe("bugLinkPreviewDescription (#117)", () => {
  it("gives the status only", () => {
    expect(bugLinkPreviewDescription({ status: "open" })).toBe(
      "Open issue on Ziki Issues. Sign in to view the details.",
    );
  });

  it("can't include a reporter or description, because it doesn't accept them", () => {
    const result = bugLinkPreviewDescription({ status: "resolved" });
    expect(result).not.toMatch(/reported by/i);
    expect(result).toContain("Live");
  });
});

describe("isLinkPreviewBot", () => {
  it("detects common unfurl user agents", () => {
    expect(isLinkPreviewBot("Slackbot-LinkExpanding 1.0")).toBe(true);
    expect(isLinkPreviewBot("Twitterbot/1.0")).toBe(true);
    expect(isLinkPreviewBot("Discordbot/2.0")).toBe(true);
  });

  it("rejects normal browsers", () => {
    expect(
      isLinkPreviewBot(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      ),
    ).toBe(false);
    expect(isLinkPreviewBot(null)).toBe(false);
  });

  it("rejects search crawlers so tickets stay out of the index", () => {
    expect(isLinkPreviewBot("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(
      false,
    );
    expect(isLinkPreviewBot("Mozilla/5.0 (compatible; bingbot/2.0)")).toBe(
      false,
    );
    expect(isLinkPreviewBot("Mozilla/5.0 (compatible; Applebot/0.1)")).toBe(
      false,
    );
  });
});
