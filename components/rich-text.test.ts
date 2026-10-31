import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RichText } from "./rich-text";

describe("RichText images (#119)", () => {
  it("shows images from other servers as a link instead of loading them", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { RichText } = await import("./rich-text");

    const html = renderToStaticMarkup(
      createElement(RichText, {
        content: "Look ![pixel](https://attacker.example/pixel.png?id=1)",
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://attacker.example/pixel.png?id=1"');
    expect(html).toContain(">pixel</a>");
  });

  it("loads GitHub attachments inline without sending a referrer", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { RichText } = await import("./rich-text");

    const html = renderToStaticMarkup(
      createElement(RichText, {
        content: "![shot](https://github.com/user-attachments/assets/abc123)",
      }),
    );
    expect(html).toContain('<img src="https://github.com/user-attachments/assets/abc123"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('loading="lazy"');
  });
});

describe("RichText with uploaded files (#305)", () => {
  it("shows a pasted image inline and a file as a link", () => {
    const html = renderToStaticMarkup(
      createElement(RichText, {
        content: "It crashes.\n![shot.png](/api/attachments/clabc12345)\n[console.log](/api/attachments/cldef67890)",
      }),
    );
    expect(html).toContain('<img src="/api/attachments/clabc12345" alt="shot.png"');
    expect(html).toContain('href="/api/attachments/cldef67890"');
    expect(html).not.toContain("![shot.png]");
  });

  it("keeps soft mentions as text", () => {
    const html = renderToStaticMarkup(createElement(RichText, { content: "cc @[Bob](clbob0000001) **now**" }));
    expect(html).not.toContain("<a");
  });
});
