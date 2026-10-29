import { test, expect, fileIssue } from "./fixtures";

test.use({ as: "admin" });

test("triage changes stick after saving and reloading", async ({ page, uniq, me }) => {
  await fileIssue(page, uniq("Triage check"));

  // Ziki #713: the status moves on its own as agents work; nobody sets it here.
  await expect(page.locator("#status")).toBeDisabled();
  await expect(page.getByText("Moves on its own as agents work.")).toBeVisible();

  await page.locator("#severity").selectOption("high");
  const assignee = page.locator("#assigneeId");
  await assignee.click();
  await assignee.fill(me.split(" ")[0]);
  await page.getByRole("option", { name: new RegExp(me) }).first().click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

  // The #261 regression: the selects used to snap back to the old values.
  await expect(page.locator("#severity")).toHaveValue("high");
  await page.reload();
  await expect(page.locator("#severity")).toHaveValue("high");
  // Saving triage leaves the status where it was.
  await expect(page.locator("#status")).toHaveValue("open");
  // "Open" is both the status chip and the stage there, so take the first exact match.
  await expect(page.getByRole("region", { name: "Status" }).getByText("Open", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(me).filter({ visible: true }).first()).toBeVisible();
});
