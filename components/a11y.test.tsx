// @vitest-environment jsdom
"use client";

import axe from "axe-core";
import { cleanup, render } from "@testing-library/react";
import { labelInNameMismatches } from "@/lib/a11y/label-in-name";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EntryReplyForm } from "./entry-reply-form";
import { DisputeAwardDialog } from "./dispute-award-dialog";
import { CreateBugForm } from "./create-issue-form";
import { UserSearch } from "./user-search";
import { VoteButton } from "./vote-button";
import { AnswerForm } from "@/app/(app)/questions/answer-form";

vi.mock("@/app/actions/issues", () => ({
  addCommentAction: vi.fn(),
  createBugAction: vi.fn(),
  toggleVoteAction: vi.fn(),
}));

vi.mock("@/app/(app)/points/disputes/actions", () => ({
  openDisputeAction: vi.fn(),
}));

vi.mock("@/app/(app)/questions/actions", () => ({
  answerQuestionAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  // axe probes a canvas to detect icon-font ligatures. jsdom's getContext
  // throws "Not implemented" and floods stderr; a minimal stub lets the check
  // degrade quietly instead of erroring.
  window.HTMLCanvasElement.prototype.getContext = (() =>
    ({
      font: "",
      measureText: () => ({ width: 0 }),
    })) as unknown as typeof window.HTMLCanvasElement.prototype.getContext;
});

afterEach(() => cleanup());

/**
 * axe-core needs a layout engine for two checks, and jsdom has none:
 * - `color-contrast` needs real computed colours and canvas.
 * - `region` assumes a full page with landmarks; these are isolated widgets.
 * - `label-content-name-mismatch` needs layout to decide which text is visible,
 *   so expectNoA11yViolations checks that from the text instead.
 * Everything else runs normally.
 */
const AXE_OPTIONS: axe.RunOptions = {
  rules: {
    "color-contrast": { enabled: false },
    region: { enabled: false },
  },
};

/** Render a node, run axe over it, and fail with the readable violation list. */
async function expectNoA11yViolations(node: HTMLElement) {
  const results = await axe.run(node, AXE_OPTIONS);
  const violations = results.violations.map(
    (v) => `${v.id} (${v.impact ?? "n/a"}): ${v.help}`,
  );
  // axe skips label-in-name here: jsdom reports no visible text. Check it from the text.
  for (const mismatch of labelInNameMismatches(node)) {
    violations.push(
      `label-content-name-mismatch (serious): visible text "${mismatch.visible}" is not in the accessible name "${mismatch.name}"`,
    );
  }
  expect(violations).toEqual([]);
}

const users = [{ id: "u1", name: "Alice", role: "user" as const }];

describe("component accessibility (axe)", () => {
  it("VoteButton has no violations", async () => {
    const { container } = render(<VoteButton bugId="b1" voteCount={3} />);
    await expectNoA11yViolations(container);
  });

  it("VoteButton (md, with voter avatars) has no violations", async () => {
    const { container } = render(
      <VoteButton
        bugId="b1"
        voteCount={3}
        likeCount={2}
        size="md"
        showAvatars
        likeVoters={[{ id: "u1", name: "Alice", image: null }]}
      />,
    );
    await expectNoA11yViolations(container);
  });

  it("EntryReplyForm has no violations", async () => {
    const { container } = render(<EntryReplyForm bugId="b1" target={{ bidId: "bid1" }} label="Reply to this bid" />);
    await expectNoA11yViolations(container);
  });

  it("DisputeAwardDialog has no violations", async () => {
    const { container } = render(<DisputeAwardDialog bugNumber={7} roles={["solver", "reporter"]} />);
    await expectNoA11yViolations(container);
  });

  it("CreateBugForm has no violations", async () => {
    const { container } = render(
      <CreateBugForm
        users={users}
        categories={[{ id: "c1", name: "macOS" }]}
        types={[{ id: "t1", name: "Bug" }]}
        isAdmin
      />,
    );
    await expectNoA11yViolations(container);
  });

  it("CreateBugForm quick report in the modal has no violations (#report-modal)", async () => {
    const { container } = render(
      <CreateBugForm
        users={users}
        categories={[{ id: "c1", name: "macOS" }]}
        types={[{ id: "t1", name: "Bug" }]}
        isAdmin={false}
        currentUserId="u1"
        variant="modal"
        reportedFrom="/issues"
      />,
    );
    await expectNoA11yViolations(container);
  });

  it("UserSearch has no violations", async () => {
    const { container } = render(<UserSearch />);
    await expectNoA11yViolations(container);
  });

  it("AnswerForm (with aria-labelledby) has no violations and avoids duplicate label", async () => {
    const { container } = render(
      <div>
        <h2 id="your-answer-heading">Your answer</h2>
        <AnswerForm questionId="q1" labelledBy="your-answer-heading" />
      </div>,
    );
    await expectNoA11yViolations(container);
    expect(container.querySelectorAll("label")).toHaveLength(0);
    const textarea = container.querySelector("textarea")!;
    expect(textarea.getAttribute("aria-labelledby")).toBe("your-answer-heading");
  });
});
