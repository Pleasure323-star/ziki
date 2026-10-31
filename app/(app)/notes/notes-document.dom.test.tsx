// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const mocks = vi.hoisted(() => ({ save: vi.fn(), restore: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("./actions", () => ({ saveNotesAction: mocks.save, restoreNotesAction: mocks.restore }));
vi.mock("@/components/markdown-editor", () => ({ MarkdownEditor: ({ value, onChange, allowUploads: _allowUploads, ...props }: { value: string; onChange: (value: string) => void; allowUploads?: boolean }) => { void _allowUploads; return <textarea {...props} value={value} onChange={(event) => onChange(event.target.value)} />; } }));
import { NotesDocument } from "./notes-document";
import { ProjectNotesLink } from "@/components/project-notes-link";
const notes = { body: "Use migrations only.", version: 2, editorName: "Admin", editorAgentId: "admin-agent", updatedAt: "2026-10-28T06:00:00.000Z" };
const revisions = [{ id: "r1", version: 1, body: "Original guidance", editorName: "Owner", editorAgentId: null, reason: "Initial", createdAt: notes.updatedAt }];
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("project notes interactions", () => {
  it("opens /notes with an accessible notebook link", () => {
    render(<ProjectNotesLink />);
    expect(screen.getByRole("link", { name: "Project notes" }).getAttribute("href")).toBe("/notes");
  });
  it("shows official guidance and attribution without edit controls for readers", () => {
    render(<NotesDocument projectId="p" notes={notes} canEdit={false} revisions={revisions} />);
    expect(screen.getByText("Use migrations only.")).toBeTruthy();
    expect(screen.getByText(/Admin/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit notes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore version 1" })).toBeNull();
  });
  it("lets authorized humans create notes when there are none", () => {
    render(<NotesDocument projectId="p" notes={null} canEdit revisions={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Create notes" }));
    expect(screen.getByRole("textbox", { name: "Official notes" })).toBeTruthy();
  });
  it("saves a draft with the version originally opened", async () => {
    mocks.save.mockResolvedValue({ version: 3 });
    render(<NotesDocument projectId="p" notes={notes} canEdit revisions={revisions} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Official notes" }), { target: { value: "Updated guidance" } });
    fireEvent.change(screen.getByLabelText("Change summary"), { target: { value: "Clarify migration policy" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("p", { body: "Updated guidance", expectedVersion: 2, reason: "Clarify migration policy" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("saved"));
    expect(mocks.refresh).toHaveBeenCalled();
  });
  it("keeps an unsaved draft and its original version after a conflict or refresh", async () => {
    mocks.save.mockResolvedValue({ error: "Notes changed. Reload the latest version before saving your draft." });
    const view = render(<NotesDocument projectId="p" notes={notes} canEdit revisions={revisions} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit notes" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Official notes" }), { target: { value: "My draft" } });
    fireEvent.change(screen.getByLabelText("Change summary"), { target: { value: "Draft change" } });
    view.rerender(<NotesDocument projectId="p" notes={{ ...notes, version: 3, body: "Someone else's change" }} canEdit revisions={revisions} />);
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Notes changed"));
    expect((screen.getByRole("textbox", { name: "Official notes" }) as HTMLTextAreaElement).value).toBe("My draft");
    expect(mocks.save).toHaveBeenCalledWith("p", expect.objectContaining({ expectedVersion: 2 }));
  });
  it("restores an old revision with the current version for conflict detection", async () => {
    mocks.restore.mockResolvedValue({ version: 3 });
    render(<NotesDocument projectId="p" notes={notes} canEdit revisions={revisions} />);
    fireEvent.click(screen.getByText("Revision history"));
    fireEvent.click(screen.getByRole("button", { name: "Restore version 1" }));
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith("p", "r1", { expectedVersion: 2, reason: "Restore version 1" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("new revision"));
  });
});
