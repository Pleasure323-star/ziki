import { LocalTime } from "@/components/local-time";
import type { NextStep, NextStepTone } from "@/lib/next-step";

const TONE: Record<NextStepTone, { box: string; dot: string }> = {
  warn: { box: "border-zk-warn-fg/40 bg-zk-warn-bg", dot: "bg-zk-warn-fg" },
  info: { box: "border-zk-info-fg/40 bg-zk-info-bg", dot: "bg-zk-info-fg" },
  ok: { box: "border-zk-ok-fg/40 bg-zk-ok-bg", dot: "bg-zk-ok-fg" },
  bad: { box: "border-zk-bad-fg/40 bg-zk-bad-bg", dot: "bg-zk-bad-fg" },
  violet: { box: "border-violet-400/50 bg-violet-50 dark:bg-violet-950/40", dot: "bg-violet-600" },
  neutral: { box: "border-zk-border bg-zk-chip", dot: "bg-zk-muted" },
};

function Icon({ tone }: { tone: NextStepTone }) {
  const path =
    tone === "ok" ? <path d="M5 12.5l4.5 4.5L19 7.5" />
    : tone === "bad" ? <path d="M18 6 6 18M6 6l12 12" />
    : tone === "warn" ? <path d="M12 7v6M12 17h.01" />
    : <path d="M5 12h14M13 6l6 6-6 6" />;
  return (
    <span aria-hidden="true" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white ${TONE[tone].dot}`}>
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        {path}
      </svg>
    </span>
  );
}

/**
 * The bar at the top of every issue and idea page (#next-step): where it
 * stands, and who should act now ("Managers: please convert this idea to an
 * issue."). Always shown, so the instruction is never hidden.
 */
export function NextStepBar({ step }: { step: NextStep }) {
  return (
    <section
      aria-label="Next step"
      data-testid="next-step-bar"
      data-tone={step.tone}
      className={`flex items-start gap-3 rounded-2xl border-2 px-4 py-3 ${TONE[step.tone].box}`}
    >
      <Icon tone={step.tone} />
      <div className="min-w-0">
        <p className="m-0 text-[15px] font-extrabold text-zk-text">{step.title}</p>
        {step.detail || step.offeredAt ? (
          <p className="m-0 mt-0.5 text-[13px] text-zk-text2">
            {step.detail}
            {step.offeredAt ? (
              <span data-testid="next-step-offered-at">
                {step.detail ? " " : ""}Offered <LocalTime date={step.offeredAt} />.
              </span>
            ) : null}
          </p>
        ) : null}
        {step.actor && step.action ? (
          <p className="m-0 mt-1 text-[13px] text-zk-text" data-testid="next-step-instruction">
            <b className="font-bold">{step.actor}:</b> {step.action}
          </p>
        ) : null}
      </div>
    </section>
  );
}
