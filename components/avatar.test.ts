import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar } from "./avatar";
import { UserNameWithBadges } from "./user-name-with-badges";
import { VoterAvatars } from "./voter-avatars";

const html = (props: Parameters<typeof Avatar>[0]) =>
  renderToStaticMarkup(createElement(Avatar, props));

describe("Avatar (#290)", () => {
  it("is decorative: hidden from assistive tech, image has empty alt", () => {
    const out = html({ name: "Ada Lovelace", image: "https://img.test/a.png" });
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain('alt=""');
    expect(out).not.toContain("title=");
  });

  it("shows initials with no image, and keeps them underneath when there is one", () => {
    expect(html({ name: "Ada Lovelace" })).toContain("AL");
    expect(html({ name: "Ada Lovelace" })).not.toContain("<img");
    expect(html({ name: "Ada Lovelace", image: "https://img.test/a.png" })).toContain("AL");
  });

  it("asks for the image without a referrer, lazily", () => {
    const out = html({ name: "Ada", image: "https://img.test/a.png" });
    // React writes this attribute camelCased in static markup; HTML ignores case.
    expect(out.toLowerCase()).toContain('referrerpolicy="no-referrer"');
    expect(out).toContain('loading="lazy"');
  });

  it("falls back to initials instead of using a non-https or script URL", () => {
    for (const image of ["http://img.test/a.png", "javascript:alert(1)", "data:image/png;base64,AAAA"]) {
      expect(html({ name: "Ada Lovelace", image })).not.toContain("<img");
    }
  });

  it("has a fixed box per size, so nothing shifts when the image loads or fails", () => {
    expect(html({ name: "A", size: "xs" })).toContain("h-5 w-5");
    expect(html({ name: "A", size: "sm" })).toContain("h-6 w-6");
    expect(html({ name: "A", size: "md" })).toContain("h-8 w-8");
    expect(html({ name: "A", size: "lg" })).toContain("h-10 w-10");
  });

  it("copes with a missing name", () => {
    expect(html({ name: null })).toContain("?");
  });
});

describe("where it's used", () => {
  it("UserNameWithBadges draws it only when asked, and names the person once", () => {
    const plain = renderToStaticMarkup(createElement(UserNameWithBadges, { name: "Ada Lovelace" }));
    expect(plain).not.toContain("aria-hidden");
    const withAvatar = renderToStaticMarkup(
      createElement(UserNameWithBadges, { name: "Ada Lovelace", avatar: "sm", image: "https://img.test/a.png" }),
    );
    expect(withAvatar).toContain('aria-hidden="true"');
    expect(withAvatar.match(/Ada Lovelace/g)).toHaveLength(1);
  });

  it("voter faces use the same component and don't announce each name twice", () => {
    const out = renderToStaticMarkup(
      createElement(VoterAvatars, {
        voters: [{ id: "1", name: "Ada Lovelace", image: "https://img.test/a.png" }],
        totalCount: 1,
      }),
    );
    expect(out).toContain('alt=""');
    expect(out).toContain('aria-label="1 person marked this important"');
    expect(out).not.toContain('alt="Ada Lovelace"');
  });
});
