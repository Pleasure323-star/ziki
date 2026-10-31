import { describe, expect, it } from "vitest";
import {
  isGitHubPaste,
  sanitizeGitHubPaste,
  stripGitHubMarkup,
} from "./github-paste";

describe("isGitHubPaste", () => {
  it("detects GitHub DOM data attributes", () => {
    const html = `<div data-hovercard-type="user" data-hovercard-url="/users/octocat/hovercard">@octocat</div>`;
    expect(isGitHubPaste(html, "@octocat")).toBe(true);
  });

  it("detects GitHub DOM classes", () => {
    const html = `<div class="js-comment-body markdown-body"><p>Found a memory leak here.</p></div>`;
    expect(isGitHubPaste(html, "Found a memory leak here.")).toBe(true);
  });

  it("detects GitHub asset domains in HTML", () => {
    const html = `<img src="https://avatars.githubusercontent.com/u/12345?v=4" alt="avatar" />`;
    expect(isGitHubPaste(html, "")).toBe(true);
  });

  it("detects GitHub user-attachments links", () => {
    const text = "See screenshot: https://github.com/user-attachments/assets/123-abc-456";
    expect(isGitHubPaste(null, text)).toBe(true);
  });

  it("detects GitHub issue template HTML comments in text", () => {
    const text = `### Describe the bug\n<!-- A clear and concise description of what the bug is. -->\nButton does not click.`;
    expect(isGitHubPaste(null, text)).toBe(true);
  });

  it("does not flag regular plain text", () => {
    const text = "This is a normal bug description written by the user.";
    expect(isGitHubPaste(null, text)).toBe(false);
    expect(isGitHubPaste("", text)).toBe(false);
  });

  it("does not flag standard legitimate links", () => {
    const text = "https://github.com/facebook/react";
    expect(isGitHubPaste(null, text)).toBe(false);
  });

  it("does not flag non-GitHub code snippets or lists", () => {
    const text = "- item 1\n- item 2\n\n```js\nconst x = 1;\n```";
    expect(isGitHubPaste(null, text)).toBe(false);
  });
});

describe("stripGitHubMarkup", () => {
  it("removes single-line and multi-line HTML comments", () => {
    const input = `Start\n<!-- hidden comment -->\nMiddle\n<!--\nmultiline\ncomment\n-->\nEnd`;
    const result = stripGitHubMarkup(input);
    expect(result).not.toContain("hidden comment");
    expect(result).not.toContain("multiline");
    expect(result).toBe("Start\n\nMiddle\n\nEnd");
  });

  it("removes residual leaked HTML tags", () => {
    const input = `<div class="js-comment-body"><p>Actual bug description text</p></div>`;
    const result = stripGitHubMarkup(input);
    expect(result).toBe("Actual bug description text");
  });

  it("keeps fenced code blocks exactly as written (#114)", () => {
    const code = [
      "```tsx",
      "<Provider store={store}>",
      '  <div className="app"><span>Hi</span></div>',
      "  <table><tr><td>x</td></tr></table>",
      "</Provider>",
      "const p: Promise<P> = load();",
      "",
      "",
      "",
      "<!-- not a template comment, it's code -->",
      "```",
    ].join("\n");
    expect(stripGitHubMarkup(`Steps:\n\n${code}\n\nThanks`)).toBe(`Steps:\n\n${code}\n\nThanks`);
  });

  it("keeps ~~~ fences and unclosed fences untouched", () => {
    const tilde = "~~~html\n<div><p>x</p></div>\n~~~";
    expect(stripGitHubMarkup(tilde)).toBe(tilde);
    const unclosed = "```\n<div>still code</div>";
    expect(stripGitHubMarkup(unclosed)).toBe(unclosed);
  });

  it("keeps inline code spans", () => {
    const input = "Crashes when `List<String>` is empty and `<div>` wraps `<p>`.";
    expect(stripGitHubMarkup(input)).toBe(input);
  });

  it("keeps JSX components and generics in prose (case-sensitive, exact tags)", () => {
    const input = "The <Provider> and <Popover> wrap <Page/>, typed as Promise<P> and <Divider>.";
    expect(stripGitHubMarkup(input)).toBe(input);
  });

  it("still strips leaked wrapper tags and comments outside code", () => {
    const input = '<div class="markdown-body"><p>Real text</p></div>\n<!-- template -->\n```\n<div>code</div>\n```';
    expect(stripGitHubMarkup(input)).toBe("Real text\n\n```\n<div>code</div>\n```");
  });

  it("normalizes excessive blank lines", () => {
    const input = "Paragraph 1\n\n\n\n\nParagraph 2";
    expect(stripGitHubMarkup(input)).toBe("Paragraph 1\n\nParagraph 2");
  });
});

describe("sanitizeGitHubPaste", () => {
  it("leaves non-GitHub content untouched with wasSanitized false", () => {
    const text = "Normal content from elsewhere";
    const result = sanitizeGitHubPaste(null, text);
    expect(result.wasSanitized).toBe(false);
    expect(result.sanitizedText).toBe(text);
    expect(result.message).toBeUndefined();
  });

  it("sanitizes GitHub pasted content, strips comments, and produces warning message", () => {
    const html = `<div class="js-comment-body"><p>Something crashed</p></div>`;
    const text = `### Problem\n<!-- Describe problem here -->\nSomething crashed`;
    const result = sanitizeGitHubPaste(html, text);

    expect(result.wasSanitized).toBe(true);
    expect(result.sanitizedText).toBe("### Problem\n\nSomething crashed");
    expect(result.message).toBeTruthy();
  });

  it("warns when pasted GitHub content only contained template comments", () => {
    const text = `<!--\n  Please fill out this form.\n  Do not delete this comment.\n-->`;
    const result = sanitizeGitHubPaste(null, text);

    expect(result.wasSanitized).toBe(true);
    expect(result.sanitizedText).toBe("");
    expect(result.message).toBeTruthy();
  });
});
