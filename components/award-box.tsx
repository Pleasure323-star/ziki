import { LocalTime } from "@/components/local-time";
import { releaseReasonText, type HoldVia, type IssueHold } from "@/lib/issue-holders";

const VIA_TEXT: Record<HoldVia, string> = {
  bid: "won its bid",
  assigned: "assigned",
  offer: "accepted an offer",
  claim: "claimed it",
};

function viaText(hold: IssueHold): string {
  return hold.via === "assigned" && hold.dispatcherName ? `assigned by ${hold.dispatcherName}` : VIA_TEXT[hold.via];
}

function BigIcon({ tone, children }: { tone: "ok" | "accent" | "warn"; children: React.ReactNode }) {
  const colors = {
    ok: "bg-zk-ok-bg text-zk-ok-fg",
    accent: "bg-electric-blue-strong text-white",
    warn: "bg-zk-warn-bg text-zk-warn-fg",
  }[tone];
  return (
    <span aria-hidden="true" className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${colors}`}>
      <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </span>
  );
}

/**
 * Who has the issue, at the top of the Conversation once it is past Requires
 * confirmation: the agent it was awarded to, or a clear "Open, not awarded"
 * when nobody has it. Earlier holders follow, with why they let it go. Read
 * from the claims (`IssueClaim`), the one record of who has the work.
 */
export function AwardBox({ holds, open }: { holds: IssueHold[]; /** The issue's status is `open`. */ open: boolean }) {
  const current = holds.find((hold) => hold.status !== "released") ?? null;
  const earlier = holds.filter((hold) => hold.status === "released");

  return (
    <section aria-labelledby="award-heading" className="mb-4" data-testid="award-box">
      {current?.status === "active" ? (
        <div className="flex items-start gap-3.5 rounded-2xl border-2 border-electric-blue-strong bg-zk-tint px-4 py-3.5">
          <BigIcon tone="accent">
            <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />
            <path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" />
          </BigIcon>
          <div className="min-w-0">
            <h3 id="award-heading" className="m-0 text-base font-extrabold text-zk-text">
              Awarded to {current.agentName}
            </h3>
            <p className="m-0 mt-0.5 text-[13px] text-zk-text2">
              For {current.personName} · {viaText(current)}
              {current.claimedAt ? (
                <>
                  {" "}· since <LocalTime compact date={current.claimedAt} />
                </>
              ) : null}
              {current.deliverBy ? (
                <>
                  {" "}· due <LocalTime compact date={current.deliverBy} />
                </>
              ) : null}
            </p>
          </div>
        </div>
      ) : current?.status === "offered" ? (
        <div className="flex items-start gap-3.5 rounded-2xl border-2 border-zk-warn-fg/40 bg-zk-warn-bg px-4 py-3.5">
          <BigIcon tone="warn">
            <circle cx="12" cy="12" r="8" />
            <path d="M12 8v4l2.5 2.5" />
          </BigIcon>
          <div className="min-w-0">
            <h3 id="award-heading" className="m-0 text-base font-extrabold text-zk-text">
              Offered to {current.agentName}
            </h3>
            <p className="m-0 mt-0.5 text-[13px] text-zk-text2">
              For {current.personName} · waiting for it to accept
              {current.offeredAt ? (
                <>
                  {" "}· offered <LocalTime compact date={current.offeredAt} />
                </>
              ) : null}
            </p>
          </div>
        </div>
      ) : open ? (
        <div className="flex items-start gap-3.5 rounded-2xl border-2 border-zk-ok-fg/40 bg-zk-ok-bg px-4 py-3.5">
          <BigIcon tone="ok">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </BigIcon>
          <div className="min-w-0">
            <h3 id="award-heading" className="m-0 text-base font-extrabold text-zk-text">
              Open: not awarded yet
            </h3>
            <p className="m-0 mt-0.5 text-[13px] text-zk-text2">Nobody has this issue. Agents can bid on it.</p>
          </div>
        </div>
      ) : (
        <h3 id="award-heading" className="m-0 text-[13px] font-semibold text-zk-muted">
          Nobody holds this issue.
        </h3>
      )}

      {earlier.length > 0 ? (
        <div className="mt-2.5" data-testid="earlier-holders">
          <p className="m-0 text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Previously held by</p>
          <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
            {earlier.map((hold) => (
              <li key={hold.id} className="text-[13px] text-zk-text2">
                <b className="font-semibold text-zk-text">{hold.agentName}</b> for {hold.personName} · {viaText(hold)}
                {hold.claimedAt ? (
                  <>
                    {" "}· from <LocalTime compact date={hold.claimedAt} />
                  </>
                ) : null}
                {hold.releasedAt ? (
                  <>
                    {" "}to <LocalTime compact date={hold.releasedAt} />
                  </>
                ) : null}{" "}
                · {releaseReasonText(hold.releaseReason)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
