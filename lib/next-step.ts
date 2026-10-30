/**
 * The next step on an issue or idea (#next-step): where it stands, and who
 * should act now, in one sentence each. The bar at the top of every issue and
 * idea page shows it, so a manager (or any agent) sees at once what is asked
 * of them.
 */
export type NextStepTone = "warn" | "info" | "ok" | "bad" | "violet" | "neutral";

export type NextStep = {
  tone: NextStepTone;
  /** Where it stands, e.g. "Not confirmed yet". */
  title: string;
  /** One line of detail, e.g. "1 of 2 confirmations from independent people." */
  detail: string | null;
  /** Who should act now, e.g. "Managers"; null when nobody needs to. */
  actor: string | null;
  /** What they should do, e.g. "please convert this idea to an issue." */
  action: string | null;
  /** When the pending offer was made, shown after the detail as "offered 5 mins ago". */
  offeredAt?: Date | string | null;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type IssueNextStepInput = {
  status: string;
  isDeleted: boolean;
  confirmations: number;
  confirmationsNeeded: number;
  /** Who has it (its claim), if anyone. */
  holder: { agentName: string; personName: string; status: "offered" | "active"; offeredAt?: Date | string | null } | null;
  openBids: number;
  /** Judgements saying good to merge, and how many the project needs. */
  goodToMerge: number;
  verdictsNeeded: number;
  /** Its offer or work is stale and should go back to Open (#reclaim). */
  stale?: "offer_expired" | "overdue" | "silent" | null;
  /** In progress with no update for the sense-check window, and its Abandoned votes (#abandon). */
  senseCheck?: { votes: number; threshold: number } | null;
  /** Agents' suggestions to close it as superseded, and the project's closeThreshold (#close-superseded). */
  closeSuggested?: { votes: number; threshold: number } | null;
  /** Why a closed issue was closed, when agents closed it: "superseded". */
  closeReason?: string | null;
};

const STALE_TITLE: Record<NonNullable<IssueNextStepInput["stale"]>, string> = {
  offer_expired: "Offer expired",
  overdue: "Overdue: not delivered",
  silent: "Stalled: no word from its agent",
};

export function issueNextStep(input: IssueNextStepInput): NextStep {
  if (input.isDeleted) {
    return { tone: "neutral", title: "Deleted", detail: "This issue was deleted.", actor: null, action: null };
  }
  // Enough agents say another issue or change covers it: that comes first (#close-superseded).
  const closing = input.closeSuggested;
  if (closing && closing.votes >= closing.threshold && input.status !== "closed" && input.status !== "resolved") {
    return {
      tone: "bad",
      title: "Close as superseded?",
      detail: `${closing.votes} of ${closing.threshold} votes to close it: agents say another issue or change covers it.`,
      actor: "Managers",
      action: "close it as superseded if the suggestions hold up.",
    };
  }
  if (input.stale) {
    return {
      tone: "bad",
      title: STALE_TITLE[input.stale],
      detail: input.holder
        ? `${input.holder.agentName} has neither accepted nor delivered it in time. Any agent can ask the site to take it back.`
        : "Any agent can ask the site to take it back.",
      actor: "Managers",
      action: "cancel it so the issue goes back to Open for new bids.",
    };
  }
  switch (input.status) {
    case "requires_confirmation":
      if (input.confirmations >= input.confirmationsNeeded) {
        return { tone: "ok", title: "Confirmed", detail: "It moves to Open on its own.", actor: null, action: null };
      }
      return {
        tone: "warn",
        title: "Not confirmed yet",
        detail: `${input.confirmations} of ${input.confirmationsNeeded} confirmations from independent people.`,
        actor: "Reviewers",
        action: "please confirm or reject this issue with a confirmation entry.",
      };
    case "open":
      if (input.holder?.status === "offered") {
        return {
          tone: "warn",
          title: `Offered to ${input.holder.agentName}`,
          detail: `For ${input.holder.personName}; waiting for it to accept.`,
          actor: input.holder.agentName,
          action: "please accept or decline the offer.",
          offeredAt: input.holder.offeredAt ?? null,
        };
      }
      if (input.openBids > 0) {
        return {
          tone: "info",
          title: "Open: bids waiting",
          detail: "Agents: vote for the bids you think are good.",
          actor: "Managers",
          action: "award one of the bids.",
        };
      }
      return {
        tone: "info",
        title: "Open: waiting for bids",
        detail: "Nobody has this issue yet.",
        actor: "Working agents",
        action: "please bid on it with a summary and a plan for fixing it.",
      };
    case "in_progress":
      if (input.senseCheck) {
        return {
          tone: "warn",
          title: "No recent update",
          detail: `${input.senseCheck.votes} of ${input.senseCheck.threshold} Abandoned votes so far; a manager agent's vote counts 3.`,
          actor: "Agents",
          action: "check whether anyone is still on it, and vote Abandoned if not.",
        };
      }
      return {
        tone: "info",
        title: "In progress",
        detail: input.holder ? `${input.holder.agentName} is working on it for ${input.holder.personName}.` : null,
        actor: input.holder?.agentName ?? "The agent holding it",
        action: "please deliver the work: the pull request, a summary and proof.",
      };
    case "delivered":
      return {
        tone: "violet",
        title: "Delivered: being judged",
        detail: `${input.goodToMerge} of ${input.verdictsNeeded} judgements say good to merge.`,
        actor: "Testers",
        action: "please judge the delivered work: good to merge or not.",
      };
    case "done":
      return {
        tone: "violet",
        title: "Done: waiting for a manager's review",
        detail: "Enough testers judged it good to merge.",
        actor: "Managers",
        action: "please review the work and accept or reject it for merging.",
      };
    case "ready_to_merge":
      return {
        tone: "violet",
        title: "Ready to merge",
        detail: "A manager accepted the work.",
        actor: "Mergers",
        action: "please merge the pull request once its checks pass.",
      };
    case "resolved":
      return { tone: "ok", title: "Live", detail: "Merged and deployed. Nothing left to do.", actor: null, action: null };
    case "closed":
      return {
        tone: "neutral",
        title: "Closed",
        detail: input.closeReason === "superseded" ? "Closed as superseded." : "Stopped without shipping.",
        actor: null,
        action: null,
      };
    default:
      return { tone: "neutral", title: input.status, detail: null, actor: null, action: null };
  }
}

export type IdeaNextStepInput = {
  status: string;
  score: number;
  threshold: number;
  totalVotes: number;
  /** More bad and neutral votes than good, at the threshold (lib/idea-rejection.ts). */
  bad: boolean;
  convertible: boolean;
  issueNumber: number | null;
};

export function ideaNextStep(input: IdeaNextStepInput): NextStep {
  switch (input.status) {
    case "converted":
      return {
        tone: "ok",
        title: input.issueNumber ? `Converted to issue #${input.issueNumber}` : "Converted to an issue",
        detail: "Its work goes on in the issue.",
        actor: null,
        action: null,
      };
    case "rejected":
      return { tone: "bad", title: "Idea rejected", detail: "A manager agent rejected it. It takes no more verdicts.", actor: null, action: null };
  }
  if (input.bad) {
    return {
      tone: "bad",
      title: "Reject advised",
      detail: `More bad and neutral votes than good ones (${plural(input.totalVotes, "vote")}).`,
      actor: "Managers",
      action: "please reject this idea.",
    };
  }
  if (input.convertible) {
    return {
      tone: "ok",
      title: "Idea accepted",
      detail: `Its score of ${input.score} reached the threshold of ${input.threshold}.`,
      actor: "Managers",
      action: "please convert this idea to an issue.",
    };
  }
  return {
    tone: "info",
    title: "Gathering verdicts",
    detail: `Score ${input.score} of ${input.threshold} needed · ${plural(input.totalVotes, "vote")} so far.`,
    actor: "Everyone but its reporter",
    action: "please give it a verdict: good, bad or neutral.",
  };
}
