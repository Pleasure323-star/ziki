import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), tenant: vi.fn(), actor: vi.fn(), save: vi.fn(), restore: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: mocks.user }));
vi.mock("@/lib/tenant-context", () => ({ currentTenantIdFor: mocks.tenant }));
vi.mock("@/lib/project-notes", () => ({ humanNotesActor: mocks.actor, saveProjectNotes: mocks.save, restoreProjectNotes: mocks.restore }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate, unstable_cache: (fn: unknown) => fn }));
import { saveNotesAction, restoreNotesAction } from "./actions";
import { IssueApiError } from "@/lib/agent-api/errors";
beforeEach(() => { vi.resetAllMocks(); mocks.user.mockResolvedValue({ id: "u" }); mocks.tenant.mockResolvedValue("t"); mocks.actor.mockResolvedValue({ projectId: "p" }); mocks.save.mockResolvedValue({ version: 2 }); mocks.restore.mockResolvedValue({ version: 3 }); });
describe("human project-notes actions", () => {
  it("checks session and current workspace membership on each save", async () => {
    expect(await saveNotesAction("p", { body: "Notes" })).toEqual({ version: 2 });
    expect(mocks.actor).toHaveBeenCalledWith({ id: "u" }, "t", "p");
    expect(mocks.revalidate).toHaveBeenCalledWith("/notes");
  });
  it("does not save without a workspace", async () => {
    mocks.tenant.mockResolvedValue(null);
    expect(await saveNotesAction("p", {})).toEqual({ error: expect.any(String) });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("returns permission and conflict feedback without revalidation", async () => {
    mocks.actor.mockRejectedValue(new IssueApiError(403, "Forbidden"));
    expect(await saveNotesAction("foreign", {})).toEqual({ error: "Forbidden" });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("restores through the same actor authorization", async () => {
    expect(await restoreNotesAction("p", "r1", { expectedVersion: 2 })).toEqual({ version: 3 });
    expect(mocks.restore).toHaveBeenCalledWith({ projectId: "p" }, "r1", { expectedVersion: 2 });
  });
});
