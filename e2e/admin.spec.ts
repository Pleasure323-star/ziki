import { test, expect, expectNoHorizontalScroll } from "./fixtures";

test.describe("organization admin screens", () => {
  test.use({ as: "admin" });

  test("adds a platform", async ({ page, uniq }) => {
    const name = uniq("Kiosk").slice(0, 40);
    await page.goto("/org/platforms");
    await page.getByLabel("New platform name").fill(name);
    await page.getByRole("button", { name: "Add platform" }).click();
    await expect(page.getByText(name).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("adds an issue type", async ({ page, uniq }) => {
    const name = uniq("Docs").slice(0, 45);
    await page.goto("/org/types");
    await page.getByRole("button", { name: "Add new type" }).click();
    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Create type" }).click();
    await expect(page.getByRole("cell", { name }).or(page.getByText(name)).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("a normal member reads them but can't change them", async ({ browser, width }) => {
    const { authFile } = await import("./users");
    const context = await browser.newContext({ storageState: authFile("user", width) });
    const page = await context.newPage();
    await page.goto("/org/platforms");
    await expect(page.getByLabel("New platform name")).toHaveCount(0);
    await context.close();
  });

  test("an organization admin can't open the site admin pages", async ({ page }) => {
    await page.goto("/admin/users");
    await expect(page).not.toHaveURL(/\/admin\/users/);
  });
});

test.describe("super admin", () => {
  test.use({ as: "super" });

  test("sees the site admin page", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/users/);
    await expect(page.getByRole("heading", { name: /admin/i }).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
