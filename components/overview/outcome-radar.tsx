"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  OUTCOME_RADAR_FOOTNOTE,
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
 *  1. Overview state: the human's intended outcome, then the highest-priority
 *     decision waiting on them, then routine agent activity (secondary).
 *  2. Expanded state: the decision banner compacts into a one-line strip and
 *     the inline panel shows risk, evidence, trade-offs, and an explicit
 *     choice of how the agents should proceed — with the consequence previewed
 *     before the choice is confirmed.
 *
 * The banner and panel share one source of truth so decision content never
 * appears twice on screen. Styling uses only the shared `zk-*` theme tokens so
 * light/dark themes keep working unchanged. All state is local; the prototype
 * calls no APIs and writes nothing.
 */

const toneChip: Record<RadarTone, string> = {
  ok: "bg-zk-ok-bg text-zk-ok-fg",
  info: "bg-zk-info-bg text-zk-info-fg",
  warn: "bg-zk-warn-bg text-zk-warn-fg",
};

const toneDot: Record<RadarTone, string> = {
  ok: "bg-zk-ok-fg",
  info: "bg-zk-info-fg",
  warn: "bg-zk-warn-fg",
};

const riskTone = {
  high: { chip: "bg-zk-bad-bg text-zk-bad-fg", label: "High risk" },
  medium: { chip: "bg-zk-warn-bg text-zk-warn-fg", label: "Medium risk" },
  low: { chip: "bg-zk-ok-bg text-zk-ok-fg", label: "Low risk" },
} as const;

function TradeOffCard({ tradeOff }: { tradeOff: RadarDecision["tradeOffs"][number] }) {
  return (
    <article className="flex flex-col gap-1.5 rounded-xl border border-zk-border bg-zk-surface px-3.5 py-3">
      <h5 className="text-[13px] font-bold text-zk-text">{tradeOff.title}</h5>
      <ul className="flex flex-col gap-1">
        {tradeOff.pros.map((pro) => (
          <li key={pro} className="flex items-start gap-2 text-[12.5px] leading-snug text-zk-text2">
            <span className={`mt-0.5 shrink-0 rounded px-1 py-0.5 text-[10.5px] font-bold ${toneChip.ok}`}>
              Pro
            </span>
            <span>{pro}</span>
          </li>
        ))}
        {tradeOff.cons.map((con) => (
          <li key={con} className="flex items-start gap-2 text-[12.5px] leading-snug text-zk-text2">
            <span className={`mt-0.5 shrink-0 rounded px-1 py-0.5 text-[10.5px] font-bold ${toneChip.warn}`}>
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

  // Focus the panel on open, and let Escape collapse from anywhere inside it.
  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCollapse();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCollapse]);

  return (
    <div
      ref={panelRef}
      role="region"
      aria-labelledby="outcome-radar-decision-heading"
      tabIndex={-1}
      className="mt-3 flex flex-col gap-4 rounded-2xl border border-zk-border bg-zk-bg p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue-strong sm:p-5"
    >
      {/* The panel owns the full question; the compact banner strip above no
          longer repeats it. */}
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

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Risk + evidence: judge first */}
        <div className="flex min-w-0 flex-col gap-4">
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

          <section aria-labelledby="outcome-radar-evidence" className="flex flex-col gap-2">
            <h5
              id="outcome-radar-evidence"
              className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted"
            >
              Evidence
            </h5>
            <ul className="flex flex-col gap-1.5">
              {decision.evidence.map((item) => (
                <li
                  key={item.id}
                  className="rounded-xl border border-zk-border bg-zk-surface px-3 py-2"
                >
                  <p className="text-[12.5px] font-bold text-zk-text">{item.label}</p>
                  <p className="mt-0.5 text-[12.5px] leading-snug text-zk-text2">{item.detail}</p>
                </li>
              ))}
            </ul>
          </section>
        </div>

        {/* Trade-offs + the human's call: compare, then choose */}
        <div className="flex min-w-0 flex-col gap-4">
          <section aria-labelledby="outcome-radar-tradeoffs" className="flex flex-col gap-2">
            <h5
              id="outcome-radar-tradeoffs"
              className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted"
            >
              Trade-offs
            </h5>
            <div className="grid grid-cols-1 gap-2.5">
              {decision.tradeOffs.map((tradeOff) => (
                <TradeOffCard key={tradeOff.id} tradeOff={tradeOff} />
              ))}
            </div>
          </section>

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
                <p aria-live="polite" className="min-w-0 text-[12.5px] text-zk-muted">
                  {appliedChoice
                    ? `Recorded — agents will ${appliedChoice.effect}.`
                    : `On confirm, agents will ${selected.effect}.`}
                </p>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function ActivityRow({ activity }: { activity: RadarActivity }) {
  return (
    <li className="flex items-start gap-2.5 px-0.5 py-1.5 text-[12.5px] leading-snug">
      <span
        aria-hidden="true"
        className={`mt-[6px] h-2 w-2 shrink-0 rounded-full ${toneDot[activity.tone]}`}
      />
      <p className="min-w-0 flex-1 text-zk-text2">
        <b className="font-bold text-zk-text">{activity.agentName}</b>
        <span aria-hidden="true" className="mx-1.5 text-zk-muted">·</span>
        {activity.action}
      </p>
      <span className="shrink-0 pl-2 text-[11.5px] text-zk-muted">{activity.when}</span>
    </li>
  );
}

export function OutcomeRadar({
  data = OUTCOME_RADAR_PROTOTYPE,
  initialExpanded = false,
}: {
  data?: OutcomeRadarData;
  initialExpanded?: boolean;
}) {
  const decision = data.decisions[0];
  const [expanded, setExpanded] = useState(initialExpanded);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Collapse and return focus to the banner trigger, so keyboard users stay
  // anchored to the banner. Synchronous focus is safe here: the trigger stays
  // mounted in both states.
  const collapse = useCallback(() => {
    setExpanded(false);
    triggerRef.current?.focus();
  }, []);

  if (!decision) return null;

  return (
    <section aria-labelledby="outcome-radar-heading" className="rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-[22px]">
      <h2
        id="outcome-radar-heading"
        className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted"
      >
        Outcome radar
      </h2>

      {/* Priority 1 — the human's intended outcome */}
      <div className="mt-3 flex flex-col gap-2 rounded-2xl border border-zk-border bg-zk-bg p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${toneChip[data.outcome.status.tone]}`}>
            {data.outcome.status.label}
          </span>
          <span className="rounded-full bg-zk-chip px-2 py-0.5 text-xs font-semibold text-zk-text2">
            {data.outcome.horizonLabel}
          </span>
        </div>
        <p className="text-[13px] font-bold uppercase tracking-[0.08em] text-zk-muted">
          Intended outcome
        </p>
        <p className="-mt-1 text-[15px] font-bold leading-snug text-zk-text">
          {data.outcome.intent}
        </p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-zk-muted">
          {data.outcome.signals.map((signal) => (
            <li key={signal.label}>
              <b className="font-bold text-zk-text">{signal.value}</b> {signal.label.toLowerCase()}
            </li>
          ))}
        </ul>
      </div>

      {/* Priority 2 — the single important conflict. The banner carries the
          compact question in the overview state, and minimizes to a strip once
          the panel (which owns the full question) is open, so the question is
          never on screen twice. */}
      <div
        className={`mt-4 rounded-xl border border-zk-bad-bd bg-zk-bad-soft ${
          expanded ? "flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5" : "p-4"
        }`}
      >
        {expanded ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="shrink-0 text-zk-bad-fg"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
            <span className="truncate text-[13px] font-bold text-zk-bad-fg">
              Decision open
            </span>
            <span className="text-[11.5px] text-zk-bad-fg/80">{decision.dueLabel}</span>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-zk-bad-bg px-2 py-0.5 text-[11px] font-bold text-zk-bad-fg">
                Priority · high
              </span>
              <span className="text-[12px] font-semibold text-zk-bad-fg">{decision.dueLabel}</span>
            </div>
            <p className="mt-2 text-[14px] font-extrabold leading-snug text-zk-text">
              {decision.question}
            </p>
          </>
        )}
        <button
          type="button"
          ref={triggerRef}
          aria-expanded={expanded}
          aria-controls="outcome-radar-decision"
          onClick={() => (expanded ? collapse() : setExpanded(true))}
          className={`zk-motion inline-flex h-[38px] shrink-0 items-center rounded-full bg-electric-blue-strong px-5 text-[13px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue-strong focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--zk-bg)] ${
            expanded ? "" : "mt-3"
          }`}
        >
          {expanded ? "Close decision panel" : "Review decision"}
        </button>
      </div>

      {/* State 2 — expanded inline decision panel */}
      <div id="outcome-radar-decision" hidden={!expanded}>
        {expanded ? <DecisionPanel decision={decision} onCollapse={collapse} /> : null}
      </div>

      {/* Secondary — routine agent activity, below the decision it supports */}
      <div className="mt-4">
        <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
          Agent activity · last 24 h
        </h3>
        <ul className="mt-1 divide-y divide-zk-divider">
          {data.activities.map((activity) => (
            <ActivityRow key={activity.id} activity={activity} />
          ))}
        </ul>
      </div>

      <p className="mt-4 text-[11.5px] leading-snug text-zk-muted">{OUTCOME_RADAR_FOOTNOTE}</p>
    </section>
  );
}
