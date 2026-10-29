import { DECISION_STAGES, decisionStageInfo, type DecisionStage, type StageTallies } from "@/lib/decision-stages";

/** The ✓ count for one stage. Rejections are not shown on the list card. */
export function StageTallyCounts({ stage, positive }: { stage: DecisionStage; positive: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11.5px] font-semibold tabular-nums">
      <span className="sr-only">
        {decisionStageInfo[stage].label}: {positive} positive
      </span>
      <span aria-hidden="true" className="text-zk-ok-fg">✓{positive}</span>
    </span>
  );
}

/**
 * The issues list card's stage strip (#1446): `Idea ✓8 · Open ✓1 · …`.
 * Only positive decisions are counted; stages without any are left out,
 * and nothing renders when no stage has one.
 */
export function IssueRowStageTallies({ tallies }: { tallies: StageTallies | undefined }) {
  const shown = tallies ? DECISION_STAGES.filter((stage) => tallies[stage].positive > 0) : [];
  if (!tallies || shown.length === 0) return null;

  // Spans, not a list: the card's title block is phrasing content inside its link.
  return (
    <span className="issues-row-stages flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-zk-muted">
      <span className="sr-only">Agent decisions by stage:</span>
      {shown.map((stage, index) => (
        <span key={stage} className="inline-flex items-center gap-1.5">
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          <span aria-hidden="true">{decisionStageInfo[stage].label}</span>
          <StageTallyCounts stage={stage} positive={tallies[stage].positive} />
        </span>
      ))}
    </span>
  );
}
