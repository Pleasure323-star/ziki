import { e2eDb } from "./db";
import { test, expect, fileIssue, reportIssue } from "./fixtures";
import { emailFor } from "./users";

test("a report is an idea, on its own page, that takes verdicts, not comments", async ({ page, uniq }) => {
  await reportIssue(page, uniq("Idea verdict check"));
  await expect(page).toHaveURL(/\/ideas\/\d+$/);
  await expect(page.getByRole("heading", { name: /Idea verdicts/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add comment" })).toHaveCount(0);
});

test("an issue at Requires confirmation takes confirmations, and replies under them, not comments", async ({ page, uniq, width }) => {
  const url = await fileIssue(page, uniq("Confirmation entry check"));

  // Someone else reported it, so this person is independent and may confirm it.
  const prisma = e2eDb();
  try {
    const other = await prisma.user.findUniqueOrThrow({ where: { email: emailFor("admin", width) }, select: { id: true } });
    const number = Number(new URL(url).pathname.split("/").pop());
    await prisma.bug.updateMany({ where: { number, title: { contains: "Confirmation entry check" } }, data: { reporterId: other.id, beneficiaryUserId: other.id } });
  } finally {
    await prisma.$disconnect();
  }
  await page.reload();

  await expect(page.getByRole("button", { name: "Add comment" })).toHaveCount(0);
  const panel = page.locator("#confirmations");
  await expect(panel.getByRole("heading", { name: /Confirmations/i })).toBeVisible();

  const summary = `Reproduced on Firefox ${Date.now()}.`;
  await page.getByRole("button", { name: "Add confirmation" }).click();
  const dialog = page.getByRole("dialog", { name: "Add confirmation" });
  await dialog.getByText("Confirm", { exact: true }).click();
  await dialog.getByLabel("Summary").fill(summary);
  await dialog.getByLabel("Description").fill("Opened the page, clicked Save, and got a blank page every time.");
  await dialog.getByRole("button", { name: "Give confirmation" }).click();
  await expect(dialog).toBeHidden();
  await expect(panel.getByText(summary)).toBeVisible();

  const reply = `Same on Chrome ${Date.now()}`;
  await panel.getByRole("button", { name: "Reply" }).first().click();
  const replyForm = panel.getByRole("form", { name: "Reply to this confirmation" });
  await replyForm.getByRole("textbox").fill(reply);
  await replyForm.getByRole("button", { name: "Reply" }).click();
  await expect(panel.getByText(reply)).toBeVisible();

  // Both survive a reload: they were saved, not just drawn.
  await page.reload();
  await expect(panel.getByText(summary)).toBeVisible();
  await expect(panel.getByText(reply)).toBeVisible();
});
