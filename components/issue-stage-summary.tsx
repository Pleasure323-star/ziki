"use client";

import type { Severity } from "@prisma/client";
import { severityLabel } from "@/lib/labels";
import { LocalTime } from "@/components/local-time";
import { timeOf, type AgentDecision } from "@/components/issue-agent-activity";
import { useIssueStage } from "@/components/issue-stage-context";
import {
  StageIcon,
  decisionCard,
  plural,
  stageIconName,
  stageState,
  type IconName,
  type StepState,
  type Tone,
} from "@/components/issue-progress-report";
import { decisionStageInfo, decisionTone, stageOfDecision, type DecisionStage } from "@/lib/decision-stages";

/** The state chip beside "<Stage> stage", as in the design. */
const STATE_CHIP: Record<StepState, { label: string; tone: Tone }> = {
  done: { label: "Complete", tone: "cg" },
  now: { label: "In progress", tone: "cb" },
  warn: { label: "Sent back", tone: "ca" },
  todo: { label: "Not reached", tone: "cn" },
};

function pullRequestNumber(url: string | null | undefined): string | null {
  const match = url?.match(/\/pull\/(\d+)/);
  return match ? `#${match[1]}` : null;
}

/** Where the issue stands on confirmation (#714), from `openIssueConfirmations`. */
export type ConfirmationProgress = { accepts: number; needed: number };

type SummaryInput = {
  stage: DecisionStage;
  state: StepState;
  inStage: ReadonlyArray<AgentDecision>;
  pullRequestUrl: string | null;
  severity: Severity | null;
  confirmation?: ConfirmationProgress | null;
};

/** One sentence on where the stage stands, from its decisions only. */
export function stageSummaryText({ stage, state, inStage, pullRequestUrl, severity, confirmation }: SummaryInput): string {
  if (state === "todo" && inStage.length === 0) return decisionStageInfo[stage].notReached;
  const count = (test: (d: AgentDecision) => boolean) => inStage.filter(test).length;
  const sentences: string[] = [];

  switch (stage) {
    case "idea":
      if (state === "done") sentences.push("Converted to an issue by a manager agent.");
      break;
    case "confirm": {
      const confirmed = count((d) => d.kind === "confirmed");
      const rejected = count((d) => d.kind === "rejected");
      if (confirmed) {
        sentences.push(
          `Confirmed as real and not a duplicate by ${plural(confirmed, "reviewer")}${severity ? `, severity ${severityLabel[severity]}` : ""}.`,
        );
      }
      if (rejected) sentences.push(`${plural(rejected, "reviewer")} rejected it.`);
      if (confirmation && state !== "done") {
        sentences.push(`${confirmation.accepts} of ${confirmation.needed} independent confirmations.`);
      }
      break;
    }
    case "open": {
      const claim = [...inStage].reverse().find((d) => d.kind === "claimed");
      const released = count((d) => d.kind === "claim_released");
      if (claim && claim.kind === "claimed") sentences.push(`Claimed by ${claim.agentName} for ${claim.personName}.`);
      if (released) sentences.push(`${plural(released, "claim")} ${released === 1 ? "was" : "were"} rejected.`);
      break;
    }
    case "done": {
      const good = count((d) => d.kind === "verdict" && d.goodToMerge);
      const notGood = count((d) => d.kind === "verdict" && !d.goodToMerge);
      if (!good && !notGood && pullRequestUrl) {
        const pr = pullRequestNumber(pullRequestUrl);
        sentences.push(`${pr ? `PR ${pr}` : "The pull request"} is submitted. No agent has tested it yet.`);
      } else if (good || notGood) {
        const parts = [
          good ? `${plural(good, "agent")} said good to merge` : null,
          notGood ? `${plural(notGood, "agent")} said not good to merge` : null,
        ].filter(Boolean);
        sentences.push(`${parts.join(", ")}.`);
      }
      if (state === "warn") sentences.push("Sent back for changes.");
      break;
    }
    case "ready": {
      const accepted = count((d) => d.kind === "accepted" && !d.merged);
      const asked = count((d) => d.kind === "merge_rejected");
      const failed = count((d) => d.kind === "deploy_failed");
      if (accepted) sentences.push("Manager agent marked it ready to merge.");
      if (asked) sentences.push(`${plural(asked, "merger")} asked for changes.`);
      if (failed) sentences.push(`${plural(failed, "deployment")} failed.`);
      break;
    }
    case "live":
      if (inStage.length) sentences.push("Merged and deployed.");
      break;
  }

  return sentences.length ? sentences.join(" ") : decisionStageInfo[stage].emptyText;
}

/** What still has to happen at the current stage; nothing for other stages. */
export function stagePending({ stage, state, inStage, pullRequestUrl, confirmation }: SummaryInput): string[] {
  if (state !== "now" && state !== "warn") return [];
  switch (stage) {
    case "idea":
      return ["Verdicts until the idea's score reaches the threshold", "A manager agent to convert it to an issue"];
    case "confirm": {
      if (!confirmation) return ["Independent people or agents to confirm it is real and not a duplicate"];
      const left = Math.max(0, confirmation.needed - confirmation.accepts);
      return left ? [`${plural(left, "more independent confirmation")}: real and not a duplicate`] : [];
    }
    case "open": {
      const claim = [...inStage].reverse().find((d) => d.kind === "claimed");
      return [claim && claim.kind === "claimed" ? `${claim.personName} to submit a pull request` : "An agent to claim this issue"];
    }
    case "done":
      if (state === "warn") return ["Fix the findings and resubmit the pull request", "Fresh verdict from reviewer agents"];
      if (!inStage.some((d) => d.kind === "verdict")) {
        return pullRequestUrl
          ? ["Testing by reviewer agents", "Good or not good to merge verdict"]
          : ["A pull request to be submitted"];
      }
      return ["Manager agent verdict"];
    case "ready":
      return ["Merger agent to merge and deploy"];
    case "live":
      return [];
  }
}

/**
 * The design's stage summary at the top of the Conversation card (#186): the
 * picked stage's state, a sentence, a chip per decision type, the latest
 * decision and what is still pending. It replaces the Agent decisions card.
 */
export function IssueStageSummary({
  decisions,
  currentStage,
  setback = false,
  pullRequestUrl = null,
  severity = null,
  ideaVerdicts,
  confirmation = null,
}: {
  decisions: ReadonlyArray<AgentDecision>;
  currentStage: DecisionStage;
  setback?: boolean;
  pullRequestUrl?: string | null;
  severity?: Severity | null;
  /** While it is an idea: its score, the threshold and the good, bad and neutral votes (#idea-verdicts). */
  ideaVerdicts?: { score: number; threshold: number; votes: { good: number; bad: number; neutral: number } };
  /** The issue's confirmation progress, shown on Requires confirmation (#714). */
  confirmation?: ConfirmationProgress | null;
}) {
  const picked = useIssueStage();
  const stage = picked?.stage ?? currentStage;
  const state = stageState(stage, currentStage, setback);
  const inStage = decisions
    .filter((decision) => stageOfDecision(decision) === stage)
    .sort((a, b) => timeOf(a) - timeOf(b) || a.id.localeCompare(b.id));
  const input = { stage, state, inStage, pullRequestUrl, severity, confirmation };
  const text = stageSummaryText(input);
  const pending = stagePending(input);
  const chip = STATE_CHIP[state];
  const label = decisionStageInfo[stage].label;
  const icon: IconName = state === "done" ? "check" : state === "warn" ? "undo" : stageIconName[stage];

  // One chip per decision type, in the order each first appeared.
  const tallies = new Map<string, { n: number; tone: Tone; icon: IconName }>();
  for (const decision of inStage) {
    const card = decisionCard(decision);
    const tally = tallies.get(card.label);
    if (tally) tally.n += 1;
    else tallies.set(card.label, { n: 1, tone: card.tone, icon: card.icon });
  }
  const latest = inStage[inStage.length - 1];
  // The stage's totals in the card's corner: every agent decision up or down,
  // zeros included, and on the Idea stage the verdicts that gate it.
  const up = inStage.filter((decision) => decisionTone(decision) === "positive").length;
  const down = inStage.length - up;
  const verdicts = stage === "idea" ? ideaVerdicts : undefined;

  return (
    <div key={stage} className="issue-progress ssum lg" aria-label={`${label} stage update`} role="group">
      <div className="flex items-start gap-2.5">
        <span className={`ssd ${state}`} aria-hidden="true">
          <StageIcon name={icon} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 flex flex-wrap items-center gap-2 text-[13.5px] font-semibold text-zk-text">
            {label} stage<span className={`chip ${chip.tone}`}>{chip.label}</span>
          </p>
          <p className="mb-0 mt-[3px] text-[13px] leading-[1.55] text-zk-text2">{text}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-right" aria-label={`${label} stage totals`}>
          <span className="inline-flex items-center gap-2 font-mono text-[13px] font-semibold tabular-nums">
            <span className="text-zk-ok-fg" title={`${plural(up, "agent decision")} up`}>
              <span aria-hidden="true">✓</span>
              {up}
              <span className="sr-only"> up</span>
            </span>
            <span className="text-zk-bad-fg" title={`${plural(down, "agent decision")} down`}>
              <span aria-hidden="true">✕</span>
              {down}
              <span className="sr-only"> down</span>
            </span>
          </span>
          {verdicts ? (
            <span className="text-[12px] text-zk-muted" data-testid="idea-verdict-totals">
              Score {verdicts.score} of {verdicts.threshold} · {verdicts.votes.good} good · {verdicts.votes.bad} bad ·{" "}
              {verdicts.votes.neutral} neutral
            </span>
          ) : null}
        </div>
      </div>
      {tallies.size > 0 ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {[...tallies].map(([name, tally]) => (
            <span key={name} className={`chip ${tally.tone}`}>
              <StageIcon name={tally.icon} style={{ width: 11, height: 11 }} />
              {tally.n} {name}
            </span>
          ))}
        </div>
      ) : null}
      {latest ? (
        <p className="mb-0 mt-2.5 text-[12.5px] leading-normal text-zk-muted">
          Latest · <b className="font-semibold text-zk-text">{latest.agentName}</b> · {decisionCard(latest).text}{" "}
          <span className="whitespace-nowrap">
            · <LocalTime compact date={latest.at} />
          </span>
        </p>
      ) : null}
      {pending.length > 0 ? (
        <div className="mt-3 border-t border-zk-divider pt-2.5">
          <p className="cap !text-[10.5px]">Pending</p>
          <ul className="m-0 mt-1.5 flex list-none flex-col gap-1.5 p-0">
            {pending.map((item) => (
              <li key={item} className="flex items-start gap-2 text-[13px] leading-[1.45] text-zk-text">
                <span className="spd" aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : state === "done" || state === "now" ? (
        <p className="mb-0 mt-2.5 flex items-center gap-1.5 text-[12.5px] text-zk-ok-fg">
          <StageIcon name="check" style={{ width: 13, height: 13 }} />
          Nothing pending at this stage.
        </p>
      ) : null}
    </div>
  );
}
