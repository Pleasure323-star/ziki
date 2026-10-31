// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const actions = vi.hoisted(() => ({ addNoteCommentAction: vi.fn(), voteNoteCommentAction: vi.fn() }));
vi.mock("./actions", () => actions);

import { AddNoteButton, NoteCommentComposer, NoteUpvoteButton, NOTE_COMPOSER_FIELD_ID } from "./note-comments";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("Notes page contributions (#732, #740)", () => {
  it("Add note puts the cursor in the composer", () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<><AddNoteButton /><NoteCommentComposer projectId="p1" /></>);
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(document.activeElement?.id).toBe(NOTE_COMPOSER_FIELD_ID);
  });

  it("posts a member's note, and keeps the draft when it fails", async () => {
    actions.addNoteCommentAction.mockResolvedValueOnce({ error: "Could not post the note." }).mockResolvedValueOnce({ id: "n1" });
    render(<NoteCommentComposer projectId="p1" />);
    const field = screen.getByLabelText("Add a note");
    fireEvent.change(field, { target: { value: "The staging URL changed." } });
    fireEvent.click(screen.getByRole("button", { name: "Post note" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not post the note."));
    expect(field).toHaveValue("The staging URL changed.");
    fireEvent.click(screen.getByRole("button", { name: "Post note" }));
    await waitFor(() => expect(field).toHaveValue(""));
    expect(actions.addNoteCommentAction).toHaveBeenLastCalledWith("p1", "The staging URL changed.");
  });

  it("upvotes a note and takes the vote back", async () => {
    actions.voteNoteCommentAction.mockResolvedValueOnce({ upvoted: true, upvotes: 3 }).mockResolvedValueOnce({ upvoted: false, upvotes: 2 });
    render(<NoteUpvoteButton projectId="p1" commentId="c1" upvotes={2} upvoted={false} />);
    const button = screen.getByRole("button", { name: /Upvote/ });
    fireEvent.click(button);
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveTextContent("3");
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "false"));
    expect(actions.voteNoteCommentAction).toHaveBeenLastCalledWith("p1", "c1", false);
  });
});
