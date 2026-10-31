import { describe, expect, it } from "vitest";
import {
  AREA_NONE,
  parseProjectAreaFilter,
  projectAreaFilterLabel,
  projectAreaFilterWhere,
} from "./project-area-filter";

const areas = [
  { id: "area-web", name: "Frontend" },
  { id: "area-api", name: "Backend" },
];

describe("project area filtering (#609)", () => {
  it("accepts an area belonging to the active project", () => {
    expect(parseProjectAreaFilter("area-api", areas)).toBe("area-api");
  });

  it("supports an explicit no-area filter", () => {
    expect(parseProjectAreaFilter(AREA_NONE, areas)).toBe(AREA_NONE);
    expect(projectAreaFilterWhere(AREA_NONE)).toEqual({ areaId: null });
  });

  it("treats missing, blank, and stale area ids as no filter", () => {
    expect(parseProjectAreaFilter(undefined, areas)).toBeNull();
    expect(parseProjectAreaFilter("  ", areas)).toBeNull();
    expect(parseProjectAreaFilter("area-other-project", areas)).toBeNull();
    expect(projectAreaFilterWhere(null)).toEqual({});
  });

  it("labels selected filters for the result summary", () => {
    expect(projectAreaFilterLabel("area-web", areas)).toBe("Frontend");
    expect(projectAreaFilterLabel(null, areas)).toBeNull();
  });
});