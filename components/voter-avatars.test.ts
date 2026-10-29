import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { VoterInfo } from "@/lib/voters";
import { VoterAvatars } from "./voter-avatars";
import nextConfig from "../next.config";

describe("VoterAvatars Next.js Image integration (#364)", () => {
  it("defines remotePatterns for Google and GitHub avatars in next.config.ts", () => {
    const remotePatterns = nextConfig.images?.remotePatterns ?? [];
    const hostnames = remotePatterns.map((p) => (typeof p === "object" ? p.hostname : ""));
    expect(hostnames).toContain("lh3.googleusercontent.com");
    expect(hostnames).toContain("avatars.githubusercontent.com");
  });

  it("renders null when totalCount is 0 or voters array is empty", () => {
    const html1 = renderToStaticMarkup(
      createElement(VoterAvatars, { voters: [], totalCount: 0 }),
    );
    expect(html1).toBe("");

    const html2 = renderToStaticMarkup(
      createElement(VoterAvatars, {
        voters: [],
        totalCount: 5,
      }),
    );
    expect(html2).toBe("");
  });

  it("renders avatar with proper src and voter title for voters with avatars", () => {
    const html = renderToStaticMarkup(
      createElement(VoterAvatars, {
        voters: [
          {
            id: "user-1",
            name: "Ada Lovelace",
            image: "https://avatars.githubusercontent.com/u/123",
          },
        ],
        totalCount: 1,
        size: "sm",
      }),
    );

    expect(html).toContain('title="Ada Lovelace"');
    expect(html).toContain('src="https://avatars.githubusercontent.com/u/123"');
  });

  it("renders initials fallback when image is missing", () => {
    const html = renderToStaticMarkup(
      createElement(VoterAvatars, {
        voters: [
          {
            id: "user-3",
            name: "Grace Hopper",
            image: null,
          },
        ],
        totalCount: 1,
      }),
    );

    expect(html).toContain('title="Grace Hopper"');
    expect(html).toContain("GH");
  });
});

/**
 * The "+N" badge after the voter faces names the voters it stands for
 * (#408), instead of just repeating the count.
 */

const people = (n: number): VoterInfo[] =>
  Array.from({ length: n }, (_, i) => ({ id: `u${i + 1}`, name: `User ${i + 1}`, image: null }));

const render = (voters: VoterInfo[], totalCount: number, size: "sm" | "md" = "sm") =>
  renderToStaticMarkup(createElement(VoterAvatars, { voters, totalCount, size }));

describe("VoterAvatars overflow badge (#408)", () => {
  it("has no badge when every voter has a face", () => {
    const out = render(people(3), 3);
    expect(out).not.toContain('role="button"');
    expect(out).not.toContain("Also marked important");
  });

  it("names the hidden voters, not just the count", () => {
    // #144: 11 likes, 3 faces, "+8".
    const out = render(people(11), 11);
    expect(out).toContain(">+8<");
    expect(out).not.toContain("8 more");
    expect(out).toContain(
      'aria-label="Also marked important: User 4, User 5, User 6, User 7, User 8, User 9, User 10 and User 11"',
    );
    for (let i = 4; i <= 11; i++) expect(out).toContain(`<li class="break-words">User ${i}</li>`);
  });

  it("leaves the voters who already have a face out of the list", () => {
    const out = render(people(11), 11);
    for (const name of ["User 1", "User 2", "User 3"]) {
      expect(out).not.toContain(`<li class="break-words">${name}</li>`);
    }
  });

  it("lists the names in the same order as the faces", () => {
    const out = render(people(6), 6);
    expect(out.indexOf(">User 4<")).toBeLessThan(out.indexOf(">User 5<"));
    expect(out.indexOf(">User 5<")).toBeLessThan(out.indexOf(">User 6<"));
  });

  it("caps a long list at ten names and counts the rest", () => {
    const out = render(people(13), 40);
    expect(out).toContain(">+37<");
    expect(out.match(/<li /g)).toHaveLength(10);
    expect(out).toContain(">and 27 others</p>");
    expect(out).toContain('aria-label="Also marked important: User 4,');
    expect(out).toContain('and 27 others"');
  });

  it("can be reached by keyboard, and says whether it's open", () => {
    const out = render(people(5), 5);
    expect(out).toContain('role="button"');
    expect(out).toContain('tabindex="0"');
    expect(out).toContain('aria-expanded="false"');
  });

  it("doesn't read the names out twice: the list itself is hidden from assistive tech", () => {
    const out = render(people(5), 5);
    expect(out.match(/User 4/g)).toHaveLength(2); // once in the label, once in the list
    expect(out).toMatch(/aria-hidden="true" class="absolute/);
  });

  it("still makes sense when the hidden voters weren't loaded", () => {
    const out = render(people(3), 8);
    expect(out).toContain(">+5<");
    expect(out).toContain('aria-label="5 others marked it important"');
    expect(out).not.toContain("<li ");
  });

  it("keeps each face's own name on hover", () => {
    const out = render(people(5), 5);
    expect(out).toContain('title="User 1"');
  });

  it("keeps the larger badge on the issue page", () => {
    expect(render(people(5), 5, "md")).toContain("h-7 w-7");
    expect(render(people(5), 5, "sm")).toContain("h-5 w-5");
  });
});
