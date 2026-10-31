import Link from "next/link";
import type { AgentLevel } from "@prisma/client";
import { AGENT_LEVEL_LABELS } from "@/lib/agents/levels";
import { agentActionLabel } from "@/lib/agent-audit/labels";
import { LocalTime } from "@/components/local-time";
import { issueHref } from "@/lib/issue-ref";
import { RelativeTime } from "@/components/relative-time";
import { AgentAvatar } from "@/components/agent-avatar";
import {
  agentsLink,
  agentsMutedClass,
  agentsSurface,
  levelBadgeClass,
} from "@/app/(app)/settings/agents/agents-ui";

export type AgentProfileData = {
  id: string;
  name: string;
  model: string | null;
  /** The owner's avatar pick; null wears the automatic one. */
  avatar: string | null;
  level: AgentLevel;
  revokedAt: Date | null;
  createdAt: Date;
  /** Null when the viewer owns it. */
  ownerName: string | null;
  lastActiveAt: Date | null;
  projects: string[];
  counts: { filed: number; claims: number; comments: number };
};

export type AgentActivityItem = {
  id: string;
  createdAt: Date;
  action: string;
  bug: { id: string; number: number; title: string; project: { slug: string } } | null;
  target: string | null;
  undone: boolean;
};

/** Who the agent is: avatar, level, status, model, owner, dates and what it has done so far. */
export function AgentProfileCard({
  agent,
  title,
  avatarControl = null,
  settings = null,
}: {
  agent: AgentProfileData;
  title: React.ReactNode;
  /** Stands in for the avatar when the viewer may change it: the avatar, opening a picker. */
  avatarControl?: React.ReactNode;
  /** Rename and level controls, for those who may change them. */
  settings?: React.ReactNode;
}) {
  const stats = [
    { label: "Issues filed", value: agent.counts.filed },
    { label: "Claims", value: agent.counts.claims },
    { label: "Comments", value: agent.counts.comments },
  ];
  return (
    <section className={`${agentsSurface} space-y-5 p-5 sm:p-6`} aria-label="Profile">
      <div className="flex items-start gap-4">
        {avatarControl ?? <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={72} />}
        <div className="min-w-0 space-y-1.5">
          {title}
          <div className="flex flex-wrap items-center gap-2">
            <span className={levelBadgeClass(agent.level)}>{AGENT_LEVEL_LABELS[agent.level]}</span>
            {agent.revokedAt ? (
              <span className="inline-flex items-center rounded-full bg-zk-bad-bg px-2.5 py-0.5 text-xs font-bold text-zk-bad-fg">
                Revoked
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full bg-zk-ok-bg px-2.5 py-0.5 text-xs font-bold text-zk-ok-fg">
                Active
              </span>
            )}
            {agent.model ? <span className="text-sm text-zk-muted">{agent.model}</span> : null}
          </div>
        </div>
      </div>

      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-bold uppercase tracking-[0.06em] text-zk-muted">Owner</dt>
          <dd className="mt-0.5 text-zk-text">{agent.ownerName ?? "You"}</dd>
        </div>
        <div>
          <dt className="text-xs font-bold uppercase tracking-[0.06em] text-zk-muted">Last active</dt>
          <dd className="mt-0.5 text-zk-text">
            {agent.lastActiveAt ? <RelativeTime date={agent.lastActiveAt} /> : "Never"}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-bold uppercase tracking-[0.06em] text-zk-muted">Added</dt>
          <dd className="mt-0.5 text-zk-text">
            <LocalTime date={agent.createdAt} />
          </dd>
        </div>
        <div>
          <dt className="text-xs font-bold uppercase tracking-[0.06em] text-zk-muted">
            {agent.projects.length === 1 ? "Project" : "Projects"}
          </dt>
          <dd className="mt-0.5 text-zk-text">{agent.projects.length ? agent.projects.join(", ") : "None"}</dd>
        </div>
      </dl>

      {settings ? <div className="border-t border-zk-divider pt-5">{settings}</div> : null}

      <dl className="grid grid-cols-3 gap-3">
        {stats.map((stat) => (
          <div key={stat.label} className="flex flex-col-reverse rounded-2xl bg-zk-chip/60 px-3 py-3 text-center">
            <dt className="text-xs font-semibold text-zk-muted">{stat.label}</dt>
            <dd className="text-2xl font-extrabold tabular-nums text-zk-text">{stat.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The agent's latest actions, newest first, each linked to its issue when it has one. */
export function AgentActivity({ items }: { items: AgentActivityItem[] }) {
  return (
    <section className={`${agentsSurface} p-4 sm:p-6`} aria-labelledby="activity-heading">
      <h2 id="activity-heading" className="text-sm font-bold uppercase tracking-[0.06em] text-zk-muted">
        Activity
      </h2>
      {items.length === 0 ? (
        <p className={`mt-3 ${agentsMutedClass}`}>No activity yet.</p>
      ) : (
        <ol className="mt-2 divide-y divide-zk-divider">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-3 text-sm">
              <span className="min-w-0 text-zk-text">
                <span className="font-semibold">{agentActionLabel(item.action)}</span>
                {item.bug ? (
                  <>
                    {" "}
                    <Link href={issueHref(item.bug)} className={agentsLink}>
                      #{item.bug.number} {item.bug.title}
                    </Link>
                  </>
                ) : null}
                {item.undone ? (
                  <span className="ml-2 rounded-full bg-zk-chip px-2 py-0.5 text-xs font-bold text-zk-muted">Undone</span>
                ) : null}
              </span>
              <LocalTime date={item.createdAt} className="shrink-0 text-xs text-zk-muted" />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
