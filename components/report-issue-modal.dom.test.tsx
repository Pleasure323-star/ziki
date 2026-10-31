// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const back = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ back }) }));

// A stand-in form: typing marks it dirty and Cancel asks to close, which is
// all the modal relies on.
vi.mock("@/components/create-issue-form", () => ({
  CreateIssueForm: ({ onCancel, onDirtyChange }: { onCancel?: () => void; onDirtyChange?: (d: boolean) => void }) => (
    <div>
      <label htmlFor="what">What happened?</label>
      <textarea id="what" onChange={(e) => onDirtyChange?.(e.target.value.trim() !== "")} />
      <button type="button" onClick={() => onCancel?.()}>Cancel</button>
    </div>
  ),
}));

import { ReportIssueModal } from "./report-issue-modal";

beforeAll(() => {
  // jsdom doesn't implement the modal dialog API.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});

beforeEach(() => {
  back.mockReset();
  window.localStorage.clear();
});
afterEach(cleanup);

const props = { users: [], isAdmin: false, currentUserId: "u1", projectId: "p1" };

function type(text: string) {
  fireEvent.change(screen.getByLabelText("What happened?"), { target: { value: text } });
}

describe("ReportIssueModal (#report-modal)", () => {
  it("opens as a modal dialog with a close button", () => {
    render(<ReportIssueModal {...props} />);
    const dialog = document.querySelector("dialog")!;
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
  });

  it("closes straight away when nothing has been typed", () => {
    render(<ReportIssueModal {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the close button", () => fireEvent.click(screen.getByRole("button", { name: "Close" }))],
    ["Cancel", () => fireEvent.click(screen.getByRole("button", { name: "Cancel" }))],
    ["Esc", () => fireEvent(document.querySelector("dialog")!, new Event("cancel", { cancelable: true }))],
    ["a click on the backdrop", () => fireEvent.click(document.querySelector("dialog")!)],
  ])("asks before discarding typed text when leaving with %s", (_name, leave) => {
    render(<ReportIssueModal {...props} />);
    type("Something broke");
    act(() => leave());
    expect(back).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "Discard this report?" })).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep writing" }));
  });

  it("Keep writing returns to the report", () => {
    render(<ReportIssueModal {...props} />);
    type("Something broke");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep writing" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(back).not.toHaveBeenCalled();
  });

  it("Discard clears the saved draft and closes", () => {
    window.localStorage.setItem("draft:u1:bug:new:p1", "{}");
    render(<ReportIssueModal {...props} />);
    type("Something broke");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(window.localStorage.getItem("draft:u1:bug:new:p1")).toBeNull();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("Esc while the discard question is open goes back to the report", () => {
    render(<ReportIssueModal {...props} />);
    type("Something broke");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent(document.querySelector("dialog")!, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(back).not.toHaveBeenCalled();
  });
});
