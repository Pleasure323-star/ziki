// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const giveIdeaVerdictAction = vi.hoisted(() => vi.fn());
vi.mock("@/app/actions/idea-verdicts", () => ({ giveIdeaVerdictAction }));

import { IdeaScoreBadge, IdeaVerdictsPanel, type IdeaVerdictsData } from "./idea-verdicts";

afterEach(() => cleanup());

beforeAll(() => {
  // jsdom doesn't implement the modal dialog API.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});

/** "Add verdict" (or "Update verdict") opens the form in a dialog. */
const openForm = (label = "Add verdict") => {
  fireEvent.click(screen.getByRole("button", { name: label }));
  return screen.getByRole("form", { name: "Your verdict" });
};

const data: IdeaVerdictsData = {
  ideaScore: 2,
  ideaThreshold: 3,
  votes: { good: 3, bad: 1, neutral: 1 },
  verdicts: [
    {
      id: "v1",
      opinion: "good",
      votes: 3,
      summary: "New users get stuck here.",
      description: "The full reasoning behind it.",
      onBehalfOfUserId: "ann",
      by: "Ann",
      agentName: "Scout",
      updatedAt: "2026-10-28T10:00:00Z",
    },
    {
      id: "v2",
      opinion: "bad",
      votes: 1,
      summary: "Out of scope.",
      description: "The full reasoning behind it.",
      onBehalfOfUserId: "ben",
      by: "Ben",
      agentName: null,
      updatedAt: "2026-10-27T10:00:00Z",
    },
  ],
};

const panel = (props: Partial<React.ComponentProps<typeof IdeaVerdictsPanel>> = {}) =>
  render(
    <IdeaVerdictsPanel
      ideaId="bug-1"
      data={data}
      viewerId="cy"
      block={null}
      summaryMaxChars={300}
      {...props}
    />,
  );

describe("IdeaVerdictsPanel (#idea-verdicts)", () => {
  beforeEach(() => giveIdeaVerdictAction.mockReset());

  it("shows the score against the threshold and the vote totals", () => {
    panel();
    expect(screen.getByTestId("idea-score")).toHaveTextContent(/2\D+3/);
    expect(screen.getByTitle(/good/i)).toHaveTextContent(/3/);
    expect(screen.getByTitle(/bad/i)).toHaveTextContent(/1/);
    expect(screen.getByTitle(/neutral/i)).toHaveTextContent(/1/);
  });

  it("lists each verdict with who, the opinion, the votes, the summary and its description", () => {
    panel();
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent(/good/i);
    expect(items[0]).toHaveTextContent("Ann");
    expect(items[0]).toHaveTextContent("Scout");
    expect(items[0]).toHaveTextContent(/3/);
    expect(items[0]).toHaveTextContent("New users get stuck here.");
    // The full description sits behind a chevron on the summary.
    const toggle = within(items[0]).getByText("Full description");
    expect(toggle.closest("details")).not.toHaveAttribute("open");
    expect(toggle.closest("details")).toHaveTextContent("The full reasoning behind it.");
    // A verdict is the whole entry: there is no comment to link to.
    expect(within(items[0]).queryByRole("link")).toBeNull();
    expect(items[1]).toHaveTextContent(/bad/i);
  });

  it("marks it passed when the threshold is reached", () => {
    panel({ data: { ...data, ideaScore: 3 } });
    expect(screen.getByTestId("idea-passed")).toBeInTheDocument();
  });

  it("has no check before the threshold", () => {
    panel();
    expect(screen.queryByTestId("idea-passed")).toBeNull();
  });

  it("hides the Add verdict button on your own idea and says why", () => {
    panel({ block: "own" });
    expect(screen.queryByRole("button", { name: "Add verdict" })).toBeNull();
    expect(screen.getByTestId("idea-verdict-blocked")).toBeInTheDocument();
  });

  it("prefills the viewer's earlier verdict and offers to change it", () => {
    panel({ viewerId: "ben" });
    const form = openForm("Update verdict");
    expect(within(form).getByRole("radio", { name: "Bad" })).toBeChecked();
    expect(within(form).getByLabelText("Summary")).toHaveValue("Out of scope.");
    expect(within(form).getByRole("button", { name: "Update verdict" })).toBeInTheDocument();
  });

  it("counts the summary's characters left", () => {
    panel();
    openForm();
    const summary = screen.getByLabelText("Summary");
    expect(screen.getByText(/300/)).toBeInTheDocument();
    fireEvent.change(summary, { target: { value: "Nice." } });
    expect(screen.getByText(/295/)).toBeInTheDocument();
  });

  it("checks the form before sending, then sends the verdict", async () => {
    giveIdeaVerdictAction.mockResolvedValue({ ok: true, replaced: false });
    panel();
    openForm();
    fireEvent.click(screen.getByRole("button", { name: "Give verdict" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Good" }));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "One. Two. Three." } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Because." } });
    fireEvent.click(screen.getByRole("button", { name: "Give verdict" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(giveIdeaVerdictAction).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Worth doing." } });
    fireEvent.click(screen.getByRole("button", { name: "Give verdict" }));
    await waitFor(() => expect(giveIdeaVerdictAction).toHaveBeenCalledTimes(1));
    const [ideaId, sent] = giveIdeaVerdictAction.mock.calls[0] as [string, FormData];
    expect(ideaId).toBe("bug-1");
    expect(Object.fromEntries(sent)).toEqual({ opinion: "good", summary: "Worth doing.", description: "Because." });
    // Saved, so the dialog closes.
    await waitFor(() => expect(document.querySelector("dialog")).not.toHaveAttribute("open"));
  });

  it("shows the server's error", async () => {
    giveIdeaVerdictAction.mockResolvedValue({ error: "This idea is closed." });
    panel();
    openForm();
    fireEvent.click(screen.getByRole("radio", { name: "Neutral" }));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Fine." } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "No strong view." } });
    fireEvent.click(screen.getByRole("button", { name: "Give verdict" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("This idea is closed."));
  });
});

describe("IdeaScoreBadge", () => {
  it("shows the score and names it for screen readers", () => {
    render(<IdeaScoreBadge score={-2} threshold={3} />);
    const badge = screen.getByTestId("idea-score-badge");
    expect(badge.textContent).toBe("-2");
    expect(badge).toHaveAttribute("aria-label", expect.stringMatching(/-2\D+3/));
    expect(badge).toHaveAttribute("data-tone", "neutral");
  });

  it("says so once the idea is accepted", () => {
    render(<IdeaScoreBadge score={6} threshold={3} />);
    const badge = screen.getByTestId("idea-score-badge");
    expect(badge).toHaveAttribute("aria-label", expect.stringMatching(/accepted/i));
  });

  it("marks a bad idea as reject advised", () => {
    render(<IdeaScoreBadge score={4} threshold={3} bad />);
    const badge = screen.getByTestId("idea-score-badge");
    expect(badge).toHaveAttribute("aria-label", expect.stringMatching(/reject/i));
    expect(badge).toHaveAttribute("data-tone", "bad");
  });
});
