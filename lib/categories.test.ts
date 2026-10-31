import { describe, expect, it } from "vitest";
import { categorySchema, platformSchema, createBugSchema, updateBugSchema } from "./validations/issue";

describe("categorySchema and platformSchema", () => {
  it("accepts valid platform names", () => {
    expect(categorySchema.safeParse({ name: "Mobile" }).success).toBe(true);
    expect(platformSchema.safeParse({ name: "Desktop" }).success).toBe(true);
    expect(platformSchema.safeParse({ name: "Web" }).success).toBe(true);
  });

  it("trims whitespace from category names", () => {
    const res = categorySchema.safeParse({ name: "  Mobile  " });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.name).toBe("Mobile");
    }
  });

  it("rejects names that are too short", () => {
    const res = platformSchema.safeParse({ name: "A" });
    expect(res.success).toBe(false);
  });

  it("rejects empty names", () => {
    const res = categorySchema.safeParse({ name: "   " });
    expect(res.success).toBe(false);
  });

  it("rejects names that are too long", () => {
    const res = platformSchema.safeParse({ name: "A".repeat(51) });
    expect(res.success).toBe(false);
  });
});

describe("createBugSchema with categoryId", () => {
  it("accepts valid payload with categoryId", () => {
    const res = createBugSchema.safeParse({
      title: "Navigation is broken on Safari",
      description: "Steps to reproduce: click on the hamburger menu and nothing happens.",
      categoryId: "cat_mobile",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.categoryId).toBe("cat_mobile");
    }
  });

  it("accepts payload without categoryId", () => {
    const res = createBugSchema.safeParse({
      title: "Navigation is broken on Safari",
      description: "Steps to reproduce: click on the hamburger menu and nothing happens.",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.categoryId).toBeUndefined();
    }
  });

  it("accepts payload with empty categoryId", () => {
    const res = createBugSchema.safeParse({
      title: "Navigation is broken on Safari",
      description: "Steps to reproduce: click on the hamburger menu and nothing happens.",
      categoryId: "",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.categoryId).toBe("");
    }
  });
});

describe("updateBugSchema with categoryId", () => {
  it("accepts categoryId update", () => {
    const res = updateBugSchema.safeParse({
      categoryId: "cat_desktop",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.categoryId).toBe("cat_desktop");
    }
  });

  it("accepts clearing categoryId with null or empty string", () => {
    const res1 = updateBugSchema.safeParse({ categoryId: null });
    expect(res1.success).toBe(true);

    const res2 = updateBugSchema.safeParse({ categoryId: "" });
    expect(res2.success).toBe(true);
  });
});
