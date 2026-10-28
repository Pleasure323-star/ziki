"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  OUTCOME_RADAR_PROTOTYPE,
  type OutcomeRadarData,
  type RadarActivity,
  type RadarChoice,
  type RadarDecision,
  type RadarTone,
} from "./outcome-radar.data";

/**
 * Outcome Radar — design prototype (human→agent interaction submission).
 *
 * Two states, both data-driven from `outcome-radar.data.ts`:
 *  1. Dashboard overview: the human's intended outcome, what the agents did
 *     towards it recently, and the highest-priority decision waiting on them.
 *  2. Expanded decision panel: risk, evidence, trade-offs, and an explicit
 *     choice for how the agents should proceed.
 *
 * Styling uses only the shared `zk-*` theme tokens so light/dark themes keep
 * working unchanged. All state is local; the prototype calls no APIs.
 */

const toneChip: Record<RadarTone, string> = {
  ok: "bg-zk-ok-bg text-zk-ok-fg",
  info: "bg-zk-info-bg text-zk-info-fg",
  warn: "bg-zk-warn-bg text-zk-warn-fg",
};

const riskTone = {
  high: { chip: "bg-zk-bad-bg text-zk-bad-fg", label: "High risk" },
  medium: { chip: "bg-zk-warn-bg text-zk-warn-fg", label: "Medium risk" },
  low: { chip: "bg-zk-ok-bg text-zk-ok-fg", label: "Low risk" },
} as const;

function ActivityRow({ activity }: { activity: RadarActivity }) {
  return (
    <li className="flex gap-3 rounded-xl border border-zk-border bg-zk-surface px-3.5 py-3">
      <span
        aria-hidden="true"
        className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
          activity.tone === "warn"
            ? "bg-zk-warn-fg"
            : activity.tone === "ok"
              ? "bg-zk-ok-fg"
              : "bg-zk-info-fg"
        }`}
      />
      <div className="min-w-0">
        <p className="text-[13.5px] leading-relaxed text-zk-text2">
          <b className="text-[13px] text-zk-text">{activity.agentName}</b>
          <span className="mx-1.5 text-zk-muted">·</span>
          {activity.action}
        </p>
        <p className="mt-0.5 text-[11.5px] text-zk-muted">{activity.when}</p>
      </div>
    </li>
  );
}

function TradeOffCard({ tradeOff }: { tradeOff: RadarDecision["tradeOffs"][number] }) {
  return (
    <article className="flex flex-col gap-2.5 rounded-xl border border-zk-border bg-zk-surface p-4">
      <h5 className="text-[13px] font-bold text-zk-text">{tradeOff.title}</h5>
      <ul className="flex flex-col gap-1.5">
        {tradeOff.pros.map((pro) => (
          <li key={pro} className="flex items-start gap-2 text-[12.5px] leading-snug text-zk-text2">
            <span className={`mt-0.5 rounded-md px-1.5 py-0.5 text-[10.5px] font-bold ${toneChip.ok}`}>
              Pro
            </span>
            <span>{pro}</span>
          </li>
        ))}
        {tradeOff.cons.map((con) => (
          <li key={con} className="flex items-start gap-2 text-[12.5px] leading-snug text-zk-text2">
            <span className={`mt-0.5 rounded-md px-1.5 py-0.5 text-[10.5px] font-bold ${toneChip.warn}`}>
              Con
            </span>
            <span>{con}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function DecisionPanel({
  decision,
  onCollapse,
}: {
  decision: RadarDecision;
  onCollapse: () => void;
}) {
  const [choiceId, setChoiceId] = useState<string>(decision.choices[0]?.id ?? "");
  const [appliedChoice, setAppliedChoice] = useState<RadarChoice | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const selected = decision.choices.find((c) => c.id === choiceId) ?? decision.choices[0];
  const risk = riskTone[decision.riskLevel];

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Escape collapses the panel from anywhere inside it. Subscribed to the
  // document for the panel's lifetime instead of hanging a keyboard listener
  // off a non-interactive element.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCollapse();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCollapse]);

  return (
    <div
      ref={panelRef}
      role="region"
      aria-labelledby="outcome-radar-decision-heading"
      tabIndex={-1}
      className="mt-4 flex flex-col gap-4 rounded-2xl border border-zk-border bg-zk-bg p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue-strong sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4
            id="outcome-radar-decision-heading"
            className="text-[15px] font-extrabold tracking-[-0.01em] text-zk-text"
          >
            {decision.title}
          </h4>
          <p className="mt-1 text-[13.5px] leading-relaxed text-zk-text2">{decision.question}</p>
        </div>
        <button
          type="button"
          onClick={onCollapse}
          className="zk-motion shrink-0 rounded-full border border-zk-border bg-zk-surface px-3.5 py-1.5 text-[12px] font-semibold text-zk-text hover:bg-zk-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue-strong"
        >
          Collapse
        </button>
      </div>

      {/* Risk */}
      <section aria-labelledby="outcome-radar-risk" className="flex flex-col gap-2">
        <h5
          id="outcome-radar-risk"
          className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.08em] text-zk-muted"
        >
          Risk
          <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${risk.chip}`}>
            {risk.label}
          </span>
        </h5>
        <p className="text-[13.5px] font-semibold leading-relaxed text-zk-text">
          {decision.riskSummary}
        </p>
        <ul className="flex flex-col gap-1">
          {decision.riskDetails.map((detail) => (
            <li key={detail} className="flex items-start gap-2 text-[12.5px] leading-snug text-zk-muted">
              <span aria-hidden="true" className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-zk-muted" />
              <span>{detail}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Evidence */}
      <section aria-labelledby="outcome-radar-evidence" className="flex flex-col gap-2">
        <h5
          id="outcome-radar-evidence"
          className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted"
        >
          Evidence
        </h5>
        <ul className="flex flex-col gap-2">
          {decision.evidence.map((item) => (
            <li
              key={item.id}
              className="rounded-xl border border-zk-border bg-zk-surface px-3.5 py-2.5"
            >
              <p className="text-[12.5px] font-bold text-zk-text">{item.label}</p>
              <p className="mt-0.5 text-[12.5px] leading-snug text-zk-text2">{item.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* Trade-offs */}
      <section aria-labelledby="outcome-radar-tradeoffs" className="flex flex-col gap-2">
        <h5
          id="outcome-radar-tradeoffs"
          className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted"
        >
          Trade-offs
        </h5>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {decision.tradeOffs.map((tradeOff) => (
            <TradeOffCard key={tradeOff.id} tradeOff={tradeOff} />
          ))}
        </div>
      </section>

      {/* Human choice */}
      <section aria-labelledby="outcome-radar-choice" className="flex flex-col gap-2">
        <h5
          id="outcome-radar-choice"
          className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted"
        >
          Your call — how should the agents proceed?
        </h5>
        <div
          role="radiogroup"
          aria-labelledby="outcome-radar-choice"
          className="flex flex-col gap-2"
        >
          {decision.choices.map((choice) => (
            <label
              key={choice.id}
              className={`flex cursor-pointer gap-3 rounded-xl border bg-zk-surface px-3.5 py-3 motion-safe:transition-colors ${
                choiceId === choice.id
                  ? "border-electric-blue-strong ring-1 ring-electric-blue-strong"
                  : "border-zk-border hover:bg-zk-chip/40"
              }`}
            >
              <input
                type="radio"
                name="outcome-radar-proceed"
                value={choice.id}
                checked={choiceId === choice.id}
                onChange={() => setChoiceId(choice.id)}
                className="mt-1 h-4 w-4 accent-[var(--zk-accent)]"
              />
              <span className="min-w-0">
                <span className="block text-[13px] font-bold text-zk-text">{choice.label}</span>
                <span className="mt-0.5 block text-[12.5px] leading-snug text-zk-muted">
                  {choice.description}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setAppliedChoice(selected ?? null)}
            className="zk-motion inline-flex h-[38px] items-center rounded-full bg-electric-blue-strong px-5 text-[13px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue-strong focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--zk-bg)]"
          >
            {appliedChoice ? "Choice recorded ✓" : "Confirm choice"}
          </button>
          {selected ? (
            <p aria-live="polite" className="text-[12.5px] text-zk-muted">
              {appliedChoice
                ? `Agents will: ${appliedChoice.effect}`
                : `On confirm, agents will: ${selected.effect.replace(/^agents\s+/i, "").toLowerCase()}`}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export function OutcomeRadar({ data = OUTCOME_RADAR_PROTOTYPE }: { data?: OutcomeRadarData }) {
  const decision = data.decisions[0];
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Returning focus to the banner trigger keeps keyboard users anchored to
  // the section after the panel unmounts. Done in the close handler rather
  // than an effect, so the initial page load never pulls focus here.
  const collapse = useCallback(() => {
    setExpanded(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  if (!decision) return null;

  return (
    <section
      aria-labelledby="outcome-radar-heading"
      className="rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-[22px]"
    >
      <h2
        id="outcome-radar-heading"
        className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.08em] text-zk-muted"
      >
        Outcome radar
        <span className="font-mono font-normal normal-case tracking-normal">
          {data.activities.length}
        </span>
      </h2>

      {/* Intended outcome */}
      <div className="mt-3 flex flex-col gap-2 rounded-2xl border border-zk-border bg-zk-bg p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${toneChip[data.outcome.status.tone]}`}>
            {data.outcome.status.label}
          </span>
          <span className="rounded-full bg-zk-chip px-2 py-0.5 text-xs font-semibold text-zk-text2">
            {data.outcome.horizonLabel}
          </span>
        </div>
        <p className="text-[15px] font-bold leading-snug text-zk-text">
          Your outcome: <span className="font-semibold">{data.outcome.intent}</span>
        </p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-zk-muted">
          {data.outcome.signals.map((signal) => (
            <li key={signal.label}>
              <b className="font-bold text-zk-text">{signal.value}</b> {signal.label.toLowerCase()}
            </li>
          ))}
        </ul>
      </div>

      {/* Agent activity */}
      <div className="mt-4">
        <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
          Agent activity · last 24 h
        </h3>
        <ul className="mt-2 flex flex-col gap-2">
          {data.activities.map((activity) => (
            <ActivityRow key={activity.id} activity={activity} />
          ))}
        </ul>
      </div>

      {/* Highest-priority decision */}
      <div className="mt-4 rounded-2xl border border-zk-bad-bd bg-zk-bad-soft p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-zk-bad-bg px-2 py-0.5 text-[11px] font-bold text-zk-bad-fg">
            Priority · high
          </span>
          <span className="text-[12px] font-semibold text-zk-bad-fg">{decision.dueLabel}</span>
        </div>
        <p className="mt-2 text-[14px] font-extrabold leading-snug text-zk-text">
          {decision.question}
        </p>
        <button
          type="button"
          ref={triggerRef}
          aria-expanded={expanded}
          aria-controls="outcome-radar-decision"
          onClick={() => (expanded ? collapse() : setExpanded(true))}
          className="zk-motion mt-3 inline-flex h-[38px] items-center rounded-full bg-electric-blue-strong px-5 text-[13px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue-strong focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--zk-bg)]"
        >
          {expanded ? "Close decision panel" : "Review decision"}
        </button>
      </div>

      {/* Expanded decision panel (state 2) */}
      <div id="outcome-radar-decision" hidden={!expanded}>
        {expanded ? <DecisionPanel decision={decision} onCollapse={collapse} /> : null}
      </div>
    </section>
  );
}
