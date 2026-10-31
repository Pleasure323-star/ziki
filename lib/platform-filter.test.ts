import { describe, expect, it } from "vitest";
import {
  PLATFORM_NONE,
  parsePlatformFilter,
  platformFilterLabel,
  platformChoices,
  platformFilterWhere,
} from "./platform-filter";

const platforms = [
  { id: "c1", name: "Web" },
  { id: "c2", name: "Mobile" },
];

describe("parsePlatformFilter", () => {
  it("accepts an id that exists", () => {
    expect(parsePlatformFilter("c2", platforms)).toBe("c2");
  });

  it("accepts the explicit no-platform value", () => {
    expect(parsePlatformFilter(PLATFORM_NONE, platforms)).toBe(PLATFORM_NONE);
  });

  it("treats a missing or blank value as no filter", () => {
    expect(parsePlatformFilter(undefined, platforms)).toBeNull();
    expect(parsePlatformFilter(null, platforms)).toBeNull();
    expect(parsePlatformFilter("   ", platforms)).toBeNull();
  });

  it("falls back to no filter for an id that no longer exists", () => {
    // A bookmark pointing at a deleted platform should show every issue,
    // not an empty list the reader cannot explain.
    expect(parsePlatformFilter("gone", platforms)).toBeNull();
  });

  it("uses the first value when the param is repeated", () => {
    expect(parsePlatformFilter(["c1", "c2"], platforms)).toBe("c1");
  });
});

describe("platformFilterWhere", () => {
  it("matches one platform", () => {
    expect(platformFilterWhere("c1")).toEqual({ categoryId: "c1" });
  });

  it("matches issues with no platform", () => {
    expect(platformFilterWhere(PLATFORM_NONE)).toEqual({ categoryId: null });
  });

  it("adds nothing when no filter is selected", () => {
    expect(platformFilterWhere(null)).toEqual({});
  });
});

describe("platformFilterLabel", () => {
  it("names the selected platform", () => {
    expect(platformFilterLabel("c2", platforms)).toBe("Mobile");
  });

  it("has nothing to say when nothing is selected", () => {
    expect(platformFilterLabel(null, platforms)).toBeNull();
  });
});

describe("inactive platforms", () => {
  const withInactive = [
    { id: "c1", name: "Web", isActive: true },
    { id: "c2", name: "Mobile", isActive: false },
  ];

  it("still resolves a link filtered on a deactivated platform", () => {
    // Deactivating a platform does not detach its issues, so a saved link
    // must keep filtering rather than silently showing everything.
    expect(parsePlatformFilter("c2", withInactive)).toBe("c2");
  });

  it("offers only active platforms in the dropdown", () => {
    expect(platformChoices(withInactive, null).map((p) => p.id)).toEqual(["c1"]);
  });

  it("also offers the selected one, so its name still shows", () => {
    expect(platformChoices(withInactive, "c2").map((p) => p.id)).toEqual(["c1", "c2"]);
  });

  it("treats a platform with no isActive flag as active", () => {
    expect(platformChoices([{ id: "c9", name: "Web" }], null)).toHaveLength(1);
  });
});
