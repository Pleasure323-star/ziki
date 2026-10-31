import { expect, test } from "./fixtures";

/**
 * Each 404 names what is missing, and only that. The in-app 404 used to say
 * "We couldn't find that issue" on every page, people and projects included.
 */
test.describe("not-found pages", () => {
  test.use({ as: "user" });

  test("an issue that doesn't exist", async ({ page }) => {
    // [id]/layout.tsx throws this 404 before streaming, so the status is real.
    const response = await page.goto("/issues/no-such-issue-e2e");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: /issue/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /issues/i }).first()).toBeVisible();
  });

  test("a person who doesn't exist", async ({ page }) => {
    await page.goto("/users/no-such-person-e2e");
    await expect(page.getByRole("heading", { name: /person/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /ranking/i }).first()).toBeVisible();
  });

  test("a redesign proposal that doesn't exist", async ({ page }) => {
    await page.goto("/redesigns/no-such-redesign-e2e");
    await expect(page.getByRole("heading", { name: /redesign/i }).first()).toBeVisible();
  });
});
