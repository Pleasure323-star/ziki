import Link from "next/link";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { currentTenantIdFor } from "@/lib/tenant-context";
import { isTenantAdmin } from "@/lib/agents/membership";
import { isAdmin } from "@/lib/roles";
import {
  disputesForMember,
  entriesForMember,
  openDisputes,
  type DisputeView,
} from "@/lib/points/disputes";
import { formatPoints } from "@/lib/points/rules";
import { Badge } from "@/components/ui/badge";
import { LocalTime } from "@/components/local-time";
import { DisputeControls } from "./dispute-controls";
import { CreditAwardsForm } from "./credit-awards-form";

export const metadata = { title: "Points disputes" };

const statusClass: Record<DisputeView["status"], string> = {
  open: "bg-zk-warn-bg text-zk-warn-fg",
  granted: "bg-zk-tint text-zk-info-fg",
  rejected: "bg-zk-chip text-zk-text2",
};

const statusLabel: Record<DisputeView["status"], string> = {
  open: "Open",
  granted: "Granted",
  rejected: "Rejected",
};

function DisputeCard({ dispute, children }: { dispute: DisputeView; children?: ReactNode }) {
  return (
    <li className="space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={statusClass[dispute.status]}>{statusLabel[dispute.status]}</Badge>
        <Badge className="rounded-full bg-zk-chip text-zk-text2">
          {dispute.kind === "wrong" ? "Wrong entry" : "Missing award"}
        </Badge>
        {dispute.kind === "missing" && dispute.requestedRole ? (
          <Badge className="rounded-full bg-zk-chip text-zk-text2">
            Requested: {dispute.requestedRole === "solver" ? "Solver" : "Reporter"}
          </Badge>
        ) : null}
        <Link
          href={dispute.bugPath}
          className="min-w-0 flex-1 truncate text-sm font-medium text-zk-text hover:underline"
        >
          #{dispute.bugNumber} {dispute.bugTitle}
        </Link>
        <span className="text-xs text-zk-muted">
          by {dispute.openerName} · <LocalTime date={dispute.createdAt} />
        </span>
      </div>
      {dispute.entry ? (
        <p className="text-xs text-zk-text2">
          Entry: {dispute.entry.points > 0 ? "+" : ""}
          {formatPoints(dispute.entry.points)} pts ({dispute.entry.role}) · {dispute.entry.id}
        </p>
      ) : null}
      <p className="text-sm text-zk-text2">{dispute.reason}</p>
      {dispute.resolution ? (
        <p className="text-sm text-zk-text2">
          Resolution: {dispute.resolution}
          {dispute.resolvedAt ? (
            <>
              {" · "}
              <LocalTime date={dispute.resolvedAt} />
            </>
          ) : null}
        </p>
      ) : null}
      {children}
    </li>
  );
}

/** Open a dispute on your own points, or resolve others' as an admin (#436). */
export default async function PointsDisputesPage() {
  const user = await requireUser();
  const tenantId = await currentTenantIdFor(user.id);
  if (!tenantId) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-zk-text">Points disputes</h1>
        <p className="rounded-[20px] border border-zk-border bg-zk-surface p-6 text-sm text-zk-text2">
          You&apos;re not a member of a workspace yet, so there are no points to dispute.
        </p>
      </div>
    );
  }

  const admin = isAdmin(user.role) || (await isTenantAdmin(user, tenantId));
  const [mine, queue, entries] = await Promise.all([
    disputesForMember(prisma, { tenantId, userId: user.id }),
    admin ? openDisputes(prisma, tenantId) : Promise.resolve([]),
    entriesForMember(prisma, { tenantId, userId: user.id }),
  ]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-zk-text">Points disputes</h1>
          <p className="text-sm text-zk-text2">
            Say an award is missing or wrong; a workspace admin resolves it. Points are never
            deleted — a correction is a reversing entry.
          </p>
        </div>
        <Link
          href="/points/disputes/new"
          className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 bg-teal-700 text-white hover:bg-teal-800 focus-visible:ring-teal-600"
        >
          Open a dispute
        </Link>
      </div>

      {admin ? (
        <section className="space-y-3 rounded-[20px] border border-zk-border bg-zk-surface p-4 sm:p-6">
          <h2 className="text-lg font-semibold text-zk-text">Credit missing awards</h2>
          <p className="text-sm text-zk-text2">
            Solver points are written when an assigned issue is marked resolved. Reporter points
            are written when two independent reviewers accept the issue as real. Use this when
            that award is missing.
          </p>
          <CreditAwardsForm />
        </section>
      ) : null}

      {admin ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-zk-text">
            Open queue <span className="text-sm font-normal text-zk-muted">({queue.length})</span>
          </h2>
          {queue.length === 0 ? (
            <p className="rounded-[20px] border border-zk-border bg-zk-surface p-6 text-sm text-zk-text2">
              No open disputes.
            </p>
          ) : (
            <ol className="divide-y divide-zk-divider rounded-[20px] border border-zk-border bg-zk-surface">
              {queue.map((dispute) => (
                <DisputeCard key={dispute.id} dispute={dispute}>
                  <DisputeControls dispute={dispute} />
                </DisputeCard>
              ))}
            </ol>
          )}
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-zk-text">Your disputes</h2>
        {mine.length === 0 ? (
          <p className="rounded-[20px] border border-zk-border bg-zk-surface p-6 text-sm text-zk-text2">
            You haven&apos;t disputed anything yet.
          </p>
        ) : (
          <ol className="divide-y divide-zk-divider rounded-[20px] border border-zk-border bg-zk-surface">
            {mine.map((dispute) => (
              <DisputeCard key={dispute.id} dispute={dispute} />
            ))}
          </ol>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-zk-text">Your points entries</h2>
        {entries.length === 0 ? (
          <p className="rounded-[20px] border border-zk-border bg-zk-surface p-6 text-sm text-zk-text2">
            No points yet. Resolve an assigned issue to earn the first ones.
          </p>
        ) : (
          <ol className="divide-y divide-zk-divider rounded-[20px] border border-zk-border bg-zk-surface">
            {entries.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                <span className="w-16 text-right text-sm font-semibold tabular-nums text-zk-text">
                  {entry.points > 0 ? "+" : ""}
                  {formatPoints(entry.points)}
                </span>
                <Badge className="rounded-full bg-zk-chip text-zk-text2">{entry.role}</Badge>
                {entry.bugNumber !== null ? (
                  <span className="min-w-0 flex-1 truncate text-sm text-zk-text2">
                    #{entry.bugNumber}
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 text-sm text-zk-muted">No issue linked</span>
                )}
                {entry.correctedAt ? (
                  <Badge className="rounded-full bg-zk-warn-bg text-zk-warn-fg">Corrected</Badge>
                ) : (
                  <Link
                    href={`/points/disputes/new?entry=${entry.id}${entry.bugNumber !== null ? `&bug=${entry.bugNumber}` : ""}`}
                    className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 bg-card text-slate-800 border border-slate-300 hover:bg-slate-50 focus-visible:ring-slate-400"
                    aria-label={`Dispute entry for ${entry.bugNumber !== null ? `issue #${entry.bugNumber}` : "unlinked entry"} (${entry.points > 0 ? "+" : ""}${formatPoints(entry.points)} pts, ${entry.role})`}
                  >
                    Dispute
                  </Link>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
