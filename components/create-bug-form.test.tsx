// @vitest-environment jsdom
"use client";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { unstable_rethrow } from "next/navigation";
import { createBugAction } from "@/app/actions/issues";
import { serializeDraft } from "@/lib/form-drafts";
import { CreateBugForm } from "./create-issue-form";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  unstable_rethrow: vi.fn(),
}));

vi.mock("@/app/actions/issues", () => ({
  createBugAction: vi.fn(),
}));

const mockedCreateBug = vi.mocked(createBugAction);
const mockedRethrow = vi.mocked(unstable_rethrow);

// Set by tests that defer the mocked action's resolution; always released in
// afterEach so a failed assertion cannot leak a pending transition.
let releasePendingAction: (() => void) | null = null;

afterEach(() => {
  releasePendingAction?.();
  releasePendingAction = null;
  cleanup();
});

const defaultProps = {
  users: [{ id: "u1", name: "Alice", role: "user" as const }],
  categories: [
    { id: "c1", name: "macOS" },
    { id: "c2", name: "Windows" },
  ],
  types: [{ id: "t1", name: "Bug" }, { id: "t2", name: "Feature" }],
  isAdmin: false,
} as Parameters<typeof CreateBugForm>[0];

let capturedFormData: FormData | null = null;

function renderForm(props: Parameters<typeof CreateBugForm>[0] = defaultProps) {
  return render(<CreateBugForm {...props} />);
}

function titleInput() {
  return screen.getByLabelText("Title") as HTMLInputElement;
}

function descriptionTextarea() {
  // The MarkdownEditor gives the mention combobox wrapper the same accessible
  // name as the textarea ("Description"), so getByLabelText matches twice.
  // Query by role to pin the actual text field (#326).
  return screen.getByRole("textbox", {
    name: "Description",
  }) as HTMLTextAreaElement;
}

function submitButton() {
  return screen.getByRole("button", {
    name: /^(Create issue|Creating…|Uploading…)$/,
  }) as HTMLButtonElement;
}

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(titleInput(), "App crashes on launch");
  await user.type(
    descriptionTextarea(),
    "Steps to reproduce: it crashes every time.",
  );
}

describe("CreateBugForm optimistic submission", () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    capturedFormData = null;
    mockedCreateBug.mockReset();
    mockedCreateBug.mockResolvedValue({ ok: true });
    mockedRethrow.mockClear();
    user = userEvent.setup({ delay: null });
  });

  it("submits the form and enables the button once the action resolves", async () => {
    // Hold the action open until the test releases it so the pending state
    // ("Creating…"/disabled) is observable instead of racing the assertion.
    mockedCreateBug.mockImplementationOnce((formData) => {
      capturedFormData = formData;
      return new Promise((resolve) => {
        releasePendingAction = () => resolve({ ok: true });
      });
    });

    renderForm();
    await fillValidForm(user);

    await user.click(submitButton());
    await waitFor(() => {
      expect(mockedCreateBug).toHaveBeenCalledTimes(1);
      expect(submitButton().disabled).toBe(true);
    });

    releasePendingAction?.();
    releasePendingAction = null;

    await waitFor(() => expect(submitButton().disabled).toBe(false));

    expect(capturedFormData?.get("title")).toBe("App crashes on launch");
    expect(capturedFormData?.get("description")).toBe(
      "Steps to reproduce: it crashes every time.",
    );
    // Default type is the first option ("Bug").
    expect(capturedFormData?.get("typeId")).toBe("t1");
    expect(capturedFormData?.get("categoryId")).toBe("");
    expect(capturedFormData?.get("proofLinks")).toBe("");

    expect(screen.queryByRole("alert")).toBeNull();
  }, 15000);

  it("shows the server error and preserves the form values on failure", async () => {
    mockedCreateBug.mockResolvedValueOnce({
      error: "Something went wrong. Please try again.",
    });

    renderForm();
    await fillValidForm(user);

    await user.click(submitButton());

    // Error surfaced and the button settled back to its idle state.
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Something went wrong. Please try again.",
      );
      expect(submitButton().disabled).toBe(false);
    });

    expect(titleInput().value).toBe("App crashes on launch");
  });

  it("does not assign anyone when the checkbox is left unchecked", async () => {
    mockedCreateBug.mockImplementationOnce((formData) => {
      capturedFormData = formData;
      return Promise.resolve({ ok: true });
    });

    renderForm({ ...defaultProps, currentUserId: "u1" });

    await fillValidForm(user);

    await user.click(submitButton());
    await waitFor(() => expect(mockedCreateBug).toHaveBeenCalledTimes(1));

    expect(capturedFormData?.get("assigneeId")).toBeNull();
  });

  it("disables submit button and prevents submission while an attachment is uploading (#734)", async () => {
    // The file input lives inside its label. user.upload clicks that input, and
    // the label can open the dialog again, so more than one request may be in
    // flight. Resolving only the last one leaves the button disabled.
    const finishUpload: Array<() => void> = [];
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpload.push(() =>
            resolve({
              ok: true,
              json: async () => ({ id: "att-456", size: 4096 }),
            }),
          );
        }),
    );

    mockedCreateBug.mockImplementationOnce((formData) => {
      capturedFormData = formData;
      return Promise.resolve({ ok: true });
    });

    try {
      const { container } = renderForm();
      await fillValidForm(user);

      const fileInput = container.querySelector(
        'input[type="file"]',
      ) as HTMLInputElement;
      expect(fileInput).toBeTruthy();

      const file = new File(["content"], "diag.png", { type: "image/png" });
      await user.upload(fileInput, file);

      // Submit button should be disabled and show Uploading…
      await waitFor(() => {
        expect(submitButton().disabled).toBe(true);
      });

      // Attempting to submit form while uploading should be prevented
      const form = container.querySelector("form") as HTMLFormElement;
      form.requestSubmit();
      expect(mockedCreateBug).not.toHaveBeenCalled();

      // Resolve every upload started by the dialog.
      finishUpload.splice(0).forEach((finish) => finish());

      // Button becomes enabled
      await waitFor(() => {
        expect(submitButton().disabled).toBe(false);
      });

      // Submit should now succeed with attachment included
      await user.click(submitButton());
      await waitFor(() => expect(mockedCreateBug).toHaveBeenCalledTimes(1));

      expect(String(capturedFormData?.get("attachmentIds"))).toContain("att-456");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("supports simplified human report intake mode without technical fields (#764)", async () => {
    mockedCreateBug.mockImplementationOnce((formData) => {
      capturedFormData = formData;
      return Promise.resolve({ ok: true });
    });

    renderForm();

    // Technical fields are visible in detailed mode
    expect(screen.getByLabelText("Platform")).toBeDefined();
    expect(screen.getByLabelText("Type")).toBeDefined();
    expect(screen.getByLabelText("GitHub PR")).toBeDefined();

    // Switch to a quick report from the full page
    await user.click(screen.getByRole("button", { name: "Send a quick report" }));

    // Technical fields should now be omitted from view
    expect(screen.queryByLabelText("Platform")).toBeNull();
    expect(screen.queryByLabelText("Type")).toBeNull();
    expect(screen.queryByLabelText("GitHub PR")).toBeNull();

    // Describe the issue in plain words
    const whatHappened = screen.getByRole("textbox", { name: "What happened?" }) as HTMLTextAreaElement;
    await user.clear(whatHappened);
    await user.type(
      whatHappened,
      "When clicking on profile settings on mobile, the screen flashes white and logs out.",
    );

    await user.click(submitButton());
    await waitFor(() => expect(mockedCreateBug).toHaveBeenCalledTimes(1));

    expect(capturedFormData?.get("isReport")).toBe("true");
    expect(capturedFormData?.get("description")).toBe(
      "When clicking on profile settings on mobile, the screen flashes white and logs out.",
    );
    expect(capturedFormData?.get("typeId")).toBeFalsy();
    expect(capturedFormData?.get("categoryId")).toBeFalsy();
    expect(capturedFormData?.get("proofLinks")).toBeFalsy();
  });
});

describe("CreateBugForm project-scoped drafts (#729)", () => {
  let user: ReturnType<typeof userEvent.setup>;
  let mockStorage: Record<string, string>;

  beforeEach(() => {
    mockStorage = {};
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => mockStorage[key] ?? null,
      setItem: (key: string, value: string) => {
        mockStorage[key] = value;
      },
      removeItem: (key: string) => {
        delete mockStorage[key];
      },
    });
    mockedCreateBug.mockReset();
    mockedCreateBug.mockResolvedValue({ ok: true });
    user = userEvent.setup({ delay: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ignores a draft saved for a different project when projectId is set", async () => {
    mockStorage["draft:u1:bug:new"] = serializeDraft(
      { title: "Leaked from another project" },
      Date.now(),
    );

    renderForm({ ...defaultProps, currentUserId: "u1", projectId: "project-a" });

    await waitFor(() => {
      expect(titleInput().value).toBe("");
    });
  });

  it("saves the create-issue draft under its project key", async () => {
    renderForm({ ...defaultProps, currentUserId: "u1", projectId: "project-a" });

    await user.type(titleInput(), "Scoped draft");

    await waitFor(() => {
      const stored = mockStorage["draft:u1:bug:new:project-a"];
      const parsed = stored
        ? (JSON.parse(stored) as { values?: { title?: string } })
        : null;
      expect(parsed?.values?.title).toBe("Scoped draft");
    });
    expect(mockStorage["draft:u1:bug:new"]).toBeUndefined();
  });

  it("clears the project draft after creation redirects to the new issue (#583)", async () => {
    const redirectError = {
      digest: "NEXT_REDIRECT;push;/issues/583;303;",
    };
    mockedCreateBug.mockRejectedValueOnce(redirectError);
    renderForm({ ...defaultProps, currentUserId: "u1", projectId: "project-a" });

    await fillValidForm(user);
    await waitFor(() => {
      expect(mockStorage["draft:u1:bug:new:project-a"]).toBeDefined();
    });

    await user.click(submitButton());
    await waitFor(() => expect(mockedCreateBug).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(mockStorage["draft:u1:bug:new:project-a"]).toBeUndefined();
    });
    expect(mockedRethrow).toHaveBeenCalledWith(redirectError);
  });

  it("preserves the project draft after an unrelated redirect", async () => {
    const redirectError = {
      digest: "NEXT_REDIRECT;push;/login;303;",
    };
    mockedCreateBug.mockRejectedValueOnce(redirectError);
    renderForm({ ...defaultProps, currentUserId: "u1", projectId: "project-a" });

    await fillValidForm(user);
    await waitFor(() => {
      expect(mockStorage["draft:u1:bug:new:project-a"]).toBeDefined();
    });

    await user.click(submitButton());
    await waitFor(() => expect(mockedRethrow).toHaveBeenCalledWith(redirectError));

    expect(mockStorage["draft:u1:bug:new:project-a"]).toBeDefined();
  });

  it("preserves the project draft when creation fails", async () => {
    mockedCreateBug.mockResolvedValueOnce({ error: "Could not create issue." });
    renderForm({ ...defaultProps, currentUserId: "u1", projectId: "project-a" });

    await fillValidForm(user);
    await waitFor(() => {
      expect(mockStorage["draft:u1:bug:new:project-a"]).toBeDefined();
    });

    await user.click(submitButton());
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());

    expect(mockStorage["draft:u1:bug:new:project-a"]).toBeDefined();
  });
});

describe("CreateBugForm quick report in a modal (#report-modal)", () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    mockedCreateBug.mockReset();
    mockedCreateBug.mockResolvedValue({ ok: true });
    capturedFormData = null;
    window.localStorage.clear();
    user = userEvent.setup({ delay: null });
  });

  function renderModal(extra: Partial<Parameters<typeof CreateBugForm>[0]> = {}) {
    return render(<CreateBugForm {...defaultProps} variant="modal" {...extra} />);
  }

  it("shows only what happened, files and the page it came from", () => {
    renderModal({ reportedFrom: "/issues" });
    expect(screen.getByRole("textbox", { name: "What happened?" })).toBeDefined();
    expect(screen.queryByLabelText("Title")).toBeNull();
    expect(screen.queryByLabelText("Platform")).toBeNull();
    expect(screen.queryByLabelText("GitHub PR")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send a quick report" })).toBeNull();
    expect(screen.getByText("/issues")).toBeDefined();
    expect(screen.getByRole("button", { name: "Send report" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Add more detail" }).getAttribute("href")).toBe("/issues/new");
  });

  it("sends a report with the page it came from, unless removed", async () => {
    mockedCreateBug.mockImplementation((formData) => {
      capturedFormData = formData;
      return Promise.resolve({ ok: true });
    });
    renderModal({ reportedFrom: "/issues/42" });
    await user.type(screen.getByRole("textbox", { name: "What happened?" }), "The save button does nothing on Safari.");
    await user.click(screen.getByRole("button", { name: "Send report" }));
    await waitFor(() => expect(mockedCreateBug).toHaveBeenCalledTimes(1));
    expect(capturedFormData?.get("isReport")).toBe("true");
    expect(capturedFormData?.get("description")).toBe(
      "The save button does nothing on Safari.\n\nReported from: /issues/42",
    );
  });

  it("leaves the page out once it's removed", async () => {
    mockedCreateBug.mockImplementation((formData) => {
      capturedFormData = formData;
      return Promise.resolve({ ok: true });
    });
    renderModal({ reportedFrom: "/issues/42" });
    await user.click(screen.getByRole("button", { name: /^Remove \/issues\/42/ }));
    expect(screen.queryByText("/issues/42")).toBeNull();
    await user.type(screen.getByRole("textbox", { name: "What happened?" }), "The save button does nothing on Safari.");
    await user.click(screen.getByRole("button", { name: "Send report" }));
    await waitFor(() => expect(mockedCreateBug).toHaveBeenCalledTimes(1));
    expect(capturedFormData?.get("description")).toBe("The save button does nothing on Safari.");
  });

  it("reports whether anything has been typed, and Cancel asks to close", async () => {
    const onDirtyChange = vi.fn();
    const onCancel = vi.fn();
    renderModal({ onDirtyChange, onCancel });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    await user.type(screen.getByRole("textbox", { name: "What happened?" }), "Broken");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("saves the draft before opening the full form, so the text carries over", async () => {
    renderModal({ currentUserId: "u1", projectId: "p1" });
    await user.type(screen.getByRole("textbox", { name: "What happened?" }), "Carry me over");
    const link = screen.getByRole("link", { name: "Add more detail" });
    link.addEventListener("click", (event) => event.preventDefault());
    await user.click(link);
    const saved = window.localStorage.getItem("draft:u1:bug:new:p1");
    expect(saved).toContain("Carry me over");
  });
});
