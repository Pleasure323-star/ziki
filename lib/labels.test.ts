import { describe, expect, it } from "vitest";
import {
  statusClass,
  statusLabel,
  statusLabels,
} from "./labels";
import { statuses } from "./validations/issue";

/**
 * These maps are indexed directly by enum value all over the app, so a
 * missing key renders "undefined" to the user rather than failing a build.
 */
describe("labels and classes cover every enum value", () => {
  it.each(statuses)("status %s has a label and a class", (status) => {
    expect(statusLabel[status], status).toBeTruthy();
    expect(statusClass[status], status).toBeTruthy();
  });

  it("has no keys beyond the enums", () => {
    expect(Object.keys(statusLabel).sort()).toEqual([...statuses].sort());
  });

  it("gives each value a distinct label", () => {
    expect(new Set(Object.values(statusLabel)).size).toBe(statuses.length);
  });

  it("labels read as prose, not as enum values", () => {
    // "in_progress" leaking into the UI is the failure this guards.
    for (const label of Object.values(statusLabel)) {
      expect(label).not.toMatch(/_/);
      expect(label[0]).toBe(label[0].toUpperCase());
    }
  });
});

describe("the plural aliases", () => {
  it("are the same objects, not copies that can drift", () => {
    expect(statusLabels).toBe(statusLabel);
  });
});
