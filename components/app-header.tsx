"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { ideasPath, orgPath } from "@/lib/project-paths";
import type { AgentLevel } from "@prisma/client";
import { SignOutButton } from "@/components/sign-out-button";
import { WorkspaceSwitcher, type WorkspaceChoice } from "@/components/workspace-switcher";
import {
  MANAGE_AGENTS_HREF,
  SITE_ADMIN_HREF,
  agentPageHref,
  isNavItemActive,
  realRoleOf,
  roleViewLabels,
} from "@/lib/header-nav";
import { AGENT_LEVEL_LABELS } from "@/lib/agents/levels";
import { isSuperAdmin, type AppRole } from "@/lib/roles";
import { Avatar } from "@/components/avatar";
import { AgentAvatar } from "@/components/agent-avatar";
import { AccountThemeSelector } from "@/components/theme-toggle";
import { formatPoints, formatPointsAsDollars } from "@/lib/points/rules";
import { recentNotificationsAction } from "@/app/actions/notifications";
import { LocalTime } from "@/components/local-time";
import { BASE_PATH } from "@/lib/base-path";
import { PAGE_CONTAINER_CLASS } from "@/components/page-container";
import { ZikiMark } from "@/components/ziki-mark";

const linkFocus =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue focus-visible:ring-offset-2";

export type ShellAgent = {
  id: string;
  name: string;
  /** The owner's avatar pick; null wears the automatic robot. */
  avatar?: string | null;
  level: string;
  /** Lifetime points this agent's work earned (#710); shown as dollars. */
  earnedPoints?: number;
};

/** Closes a popover on outside click or Escape, returning focus to its trigger. */
function useDismiss(
  open: boolean,
  close: () => void,
  containerRef: React.RefObject<HTMLElement | null>,
  triggerRef: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, containerRef, triggerRef]);
}

function TrophyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.7V17c0 .6-.5 1-1 1.2-1.2.5-2 2-2 3.8" />
      <path d="M14 14.7V17c0 .6.5 1 1 1.2 1.2.5 2 2 2 3.8" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  );
}

function EnvelopeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M12 4v4" />
      <path d="M9 14h.01" />
      <path d="M15 14h.01" />
    </svg>
  );
}

function NavIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {children}
    </svg>
  );
}

function TopNavLink({
  href,
  active,
  label,
  children,
}: {
  href: string;
  active: boolean;
  label: string;
  children: React.ReactNode;
}) {
  // Below lg this is a tab in the bottom strip: icon over a short label.
  const className = `relative inline-flex shrink-0 items-center whitespace-nowrap font-medium ${linkFocus} max-lg:min-w-16 max-lg:flex-1 max-lg:flex-col max-lg:gap-0.5 max-lg:rounded-xl max-lg:py-1.5 max-lg:text-[11px] lg:h-9 lg:gap-2 lg:rounded-full lg:px-2.5 lg:text-[13px] ${
    active ? "text-zk-accent lg:bg-zk-tint" : "text-zk-text2 hover:text-zk-text lg:hover:bg-zk-chip"
  }`;
  const inner = (
    <>
      <span className={`relative flex items-center justify-center max-lg:h-7 max-lg:w-12 max-lg:rounded-full ${active ? "max-lg:bg-zk-tint" : ""}`}>
        {children}
      </span>
      {label}
    </>
  );
  if (href.startsWith("http")) {
    return (
      <a href={href} className={className}>
        {inner}
      </a>
    );
  }
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={className}
    >
      {inner}
    </Link>
  );
}

/**
 * The workspace areas: Product (the issue tracker), Marketing and Security.
 * The logo goes to the Dashboard; the points pill opens Ranking.
 */
function TopNav({ pathname, projectSlug }: { pathname: string | null; projectSlug: string | null }) {
  // Product opens the project the page is in, or the first one (#project-urls).
  const productHref = projectSlug ? ideasPath(projectSlug) : "/tenants";
  return (
    <nav
      aria-label="Workspace"
      // Phones and tablets: a tab strip fixed to the bottom of the screen,
      // clear of the home indicator. From lg it sits inline in the top bar.
      className="flex items-center max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-40 max-lg:justify-around max-lg:border-t max-lg:border-zk-border max-lg:bg-zk-surface max-lg:px-2 max-lg:pt-1.5 max-lg:pb-[max(0.375rem,env(safe-area-inset-bottom))] max-lg:shadow-[0_-1px_3px_rgba(0,0,0,0.04)] lg:gap-1"
    >
      <TopNavLink href={productHref} active={Boolean(projectSlug && pathname?.startsWith(`/${projectSlug}`))} label="Product">
        <NavIcon>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
        </NavIcon>
      </TopNavLink>
      <TopNavLink href="https://amp.ziki.dev" active={isNavItemActive(pathname, "/marketing")} label="Marketing">
        <NavIcon>
          <path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z" />
          <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
        </NavIcon>
      </TopNavLink>
      <TopNavLink href="/security" active={isNavItemActive(pathname, "/security")} label="Security">
        <NavIcon>
          <path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z" />
          <path d="m9 12 2 2 4-4" />
        </NavIcon>
      </TopNavLink>
    </nav>
  );
}

/** In-place notification preview; opening the bell never marks alerts read (#615). */
/** The envelope (#inbox): a preview of recent notifications; its count is unread notifications plus escalations waiting on you. */
function InboxEnvelope({ unreadCount, pendingEscalations, active }: { unreadCount: number; pendingEscalations: number; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notifications, setNotifications] = useState<Awaited<ReturnType<typeof recentNotificationsAction>> | null>(null);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), containerRef, triggerRef);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus({ preventScroll: true });
    let cancelled = false;
    recentNotificationsAction().then(
      (items) => { if (!cancelled) setNotifications(items); },
      () => { if (!cancelled) setFailed(true); },
    );
    return () => { cancelled = true; };
  }, [open, attempt]);

  function loadPreview() {
    setNotifications(null);
    setFailed(false);
  }
  const total = unreadCount + pendingEscalations;
  const label = total > 0 ? `Inbox, ${total} unread` : "Inbox";
  return (
    <div ref={containerRef} className="flex items-center sm:relative" onBlur={(event) => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
    }}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls="notification-preview"
        onClick={() => { loadPreview(); setOpen((value) => !value); }}
        aria-label={label}
        title={label}
        // A plain icon, no ring: the bell only needs to be findable, not prominent.
        className={`relative inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-zk-chip ${linkFocus} ${active ? "text-zk-accent" : "text-zk-text"}`}
      >
        <EnvelopeIcon />
        {total > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-zk-surface bg-electric-blue-strong px-1 text-[11px] font-bold text-white"
          >
            {total > 99 ? "99+" : total}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          ref={panelRef}
          id="notification-preview"
          role="region"
          aria-label="Recent notifications"
          tabIndex={-1}
          className="absolute right-4 top-full z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-zk-border bg-zk-surface text-zk-text shadow-xl focus:outline-none sm:right-0"
        >
          <h2 className="border-b border-zk-border px-4 py-3 text-sm font-semibold">Notifications</h2>
          {pendingEscalations > 0 ? (
            <Link href="/inbox?tab=escalations" onClick={() => setOpen(false)} className={`block border-b border-zk-border bg-zk-warn-bg px-4 py-2.5 text-sm font-semibold text-zk-warn-fg hover:brightness-95 ${linkFocus}`}>
              {pendingEscalations} escalation{pendingEscalations === 1 ? "" : "s"} waiting on you
            </Link>
          ) : null}
          <div className="max-h-[min(26rem,calc(100dvh-11rem))] overflow-y-auto overscroll-contain">
            {failed ? (
              <div className="p-4 text-sm">
                <p role="alert">Could not load notifications.</p>
                <button type="button" className={`mt-2 text-zk-accent hover:underline ${linkFocus}`} onClick={() => { loadPreview(); setAttempt((value) => value + 1); }}>Try again</button>
              </div>
            ) : notifications === null ? (
              <p role="status" className="p-4 text-sm text-zk-muted">Loading notifications...</p>
            ) : notifications.length === 0 ? (
              <p role="status" className="p-4 text-sm text-zk-muted">No notifications yet.</p>
            ) : (
              <ul className="divide-y divide-zk-divider">
                {notifications.map((notification) => (
                  <li key={notification.id}>
                    {/* Plain links avoid prefetching the route that marks an alert read. */}
                    <a href={`${BASE_PATH}/inbox/notifications/${notification.id}`} className={`flex items-start gap-3 px-4 py-3 text-sm hover:bg-zk-chip ${linkFocus} ${!notification.readAt ? "bg-zk-tint" : ""}`}>
                      <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${!notification.readAt ? "bg-electric-blue" : "bg-transparent"}`} />
                      <span className="min-w-0 flex-1">
                        <span className={`block break-words ${!notification.readAt ? "font-medium text-zk-text" : "text-zk-text2"}`}>
                          {!notification.readAt ? <span className="sr-only">Unread: </span> : null}
                          {notification.title}
                        </span>
                        <LocalTime date={notification.createdAt} className="mt-1 block text-xs text-zk-muted" />
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Link href="/inbox" onClick={() => setOpen(false)} className={`block border-t border-zk-border px-4 py-3 text-sm font-medium text-zk-accent hover:bg-zk-chip ${linkFocus}`}>Open inbox</Link>
        </div>
      ) : null}
    </div>
  );
}

function levelLabel(level: string) {
  return level in AGENT_LEVEL_LABELS ? AGENT_LEVEL_LABELS[level as AgentLevel] : level;
}

function AgentsMenu({
  pathname,
  agents,
  points,
}: {
  pathname: string | null;
  agents: ShellAgent[];
  /** The viewer's points, shown as dollars on the button; null when signed out. */
  points: number | null;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useDismiss(open, () => setOpen(false), containerRef, buttonRef);
  const current = (pathname ?? "").replace(/\/+$/, "");
  const menuId = useId();

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
        title={points === null ? "Agents" : `Agents · ${formatPoints(points)} points`}
        // Phones: a plain icon, like the bell beside it.
        className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-full border border-zk-border bg-zk-surface px-3.5 text-[13px] font-medium text-zk-text hover:bg-zk-chip max-sm:h-9 max-sm:w-9 max-sm:border-0 max-sm:bg-transparent max-sm:px-0 ${linkFocus}`}
      >
        {/* Your agent's face and your balance in dollars. */}
        {agents[0] ? (
          <AgentAvatar agentId={agents[0].id} avatar={agents[0].avatar} size={24} />
        ) : (
          <span className="text-electric-blue max-sm:text-zk-text">
            <AgentIcon />
          </span>
        )}
        {points === null ? (
          <span className="max-sm:sr-only">Agents</span>
        ) : (
          <span className="font-semibold tabular-nums max-sm:sr-only">
            <span className="sr-only">Agents, balance </span>
            {formatPointsAsDollars(points)}
          </span>
        )}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="max-sm:hidden">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 top-12 z-50 flex w-[260px] max-w-[calc(100vw-2rem)] flex-col gap-0.5 rounded-2xl border border-zk-border bg-zk-surface p-2 text-sm shadow-[0_16px_40px_rgba(11,23,51,0.16)]"
        >
          {points !== null ? (
            <Link
              href="/workers"
              onClick={() => setOpen(false)}
              aria-current={current === "/workers" ? "page" : undefined}
              className="flex min-h-11 items-center justify-between gap-2 rounded-[10px] px-2.5 text-zk-text"
            >
              <span className="flex flex-col">
                <span className="text-base font-bold tabular-nums">{formatPointsAsDollars(points)}</span>
                <span className="text-xs text-zk-muted">{formatPoints(points)} points · Ranking</span>
              </span>
              <TrophyIcon />
            </Link>
          ) : null}
          {points !== null ? <div className="my-1 h-px bg-zk-divider" /> : null}
          {agents.length > 0 ? (
            <span className="px-2.5 pb-1.5 pt-2 text-[11px] font-bold uppercase tracking-[0.06em] text-zk-muted">
              Project agents
            </span>
          ) : null}
          {agents.map((agent) => (
            <div key={agent.id} className="flex min-h-12 items-center gap-2.5 rounded-[10px] px-2.5 text-zk-text">
              <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={30} />
              <Link href={agentPageHref(agent.name)} onClick={() => setOpen(false)} className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-semibold">{agent.name}</span>
                <span className="truncate text-xs text-zk-muted">
                  {levelLabel(agent.level)} · earned {formatPointsAsDollars(agent.earnedPoints ?? 0)}
                </span>
              </Link>
              <Link
                href={agentPageHref(agent.name)}
                onClick={() => setOpen(false)}
                className="shrink-0 rounded-full bg-electric-blue-strong px-2.5 py-1 text-xs font-bold text-white hover:brightness-110"
              >
                Earn me money
              </Link>
            </div>
          ))}
          {agents.length > 0 ? <div className="my-1 h-px bg-zk-divider" /> : null}
          <Link
            href={MANAGE_AGENTS_HREF}
            onClick={() => setOpen(false)}
            aria-current={current === MANAGE_AGENTS_HREF ? "page" : undefined}
            className="flex min-h-10 items-center gap-2 rounded-[10px] px-2.5 font-semibold text-zk-text2"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            Manage agents
          </Link>
        </div>
      ) : null}
    </div>
  );
}

export function AppHeader({
  userName,
  userImage,
  role,
  isRealSuperAdmin,
  isRealAdmin,
  unreadCount = 0,
  pendingEscalationsCount = 0,
  userId,
  workspaces = [],
  activeTenantId = null,
  points = 0,
  agents = [],
  reportFormUrl,
  organizationAdmin = false,
  defaultProjectSlug = null,
}: {
  /** The first project in the current workspace, for pages whose URL names none yet. */
  defaultProjectSlug?: string | null;
  userName?: string | null;
  userImage?: string | null;
  role?: AppRole | null;
  isRealSuperAdmin?: boolean;
  isRealAdmin?: boolean;
  unreadCount?: number;
  pendingEscalationsCount?: number;
  userId?: string | null;
  workspaces?: WorkspaceChoice[];
  activeTenantId?: string | null;
  points?: number;
  solvedTasks?: number;
  /** Platform points goal (hard-coded fallback when unset). */
  targetPoints?: number;
  agents?: ShellAgent[];
  reportFormUrl?: string;
  /** Owner or admin of the current organization, or the site super admin: shows /org in the menus. */
  organizationAdmin?: boolean;
}) {
  const pathname = usePathname();
  const projectSlug = useParams<{ project?: string }>()?.project ?? defaultProjectSlug;
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const closeAccount = () => setAccountOpen(false);
  useDismiss(accountOpen, closeAccount, accountRef, accountButtonRef);

  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setAccountOpen(false);
  }

  const realRole = realRoleOf({ isRealSuperAdmin, isRealAdmin });

  return (
    // Sticky only from lg: on phones and tablets the toolbar wraps onto rows,
    // and a header that tall pinned to the top covers the page under it.
    <header className="relative z-40 border-b border-zk-border bg-zk-surface shadow-[0_1px_3px_rgba(0,0,0,0.04)] lg:sticky lg:top-0">
      <div className={`${PAGE_CONTAINER_CLASS} flex flex-wrap items-center gap-x-3 gap-y-2 py-3 max-sm:py-2 sm:px-6`}>
        {/* Below lg the nav lives in the bottom strip, leaving one row here.
            The logo is the way to the Dashboard; phones show just its mark. */}
        <div className="flex min-w-0 items-center gap-2">
          <Link href={projectSlug ? `/${encodeURIComponent(projectSlug)}/dashboard` : "/dashboard"} aria-label="Ziki" className={`flex shrink-0 items-center gap-2 rounded-full ${linkFocus}`}>
            <ZikiMark className="h-7 w-auto text-electric-blue-strong max-sm:h-6" />
            <span aria-hidden="true" className="pr-1 text-[15px] font-semibold tracking-[-0.02em] text-zk-text max-sm:hidden">
              ziki
            </span>
          </Link>
          <span aria-hidden="true" className="h-[18px] w-px shrink-0 bg-zk-border max-sm:hidden" />
          <WorkspaceSwitcher workspaces={workspaces} activeTenantId={activeTenantId} canManage={organizationAdmin} orgHref={projectSlug ? orgPath(projectSlug) : null} tone="bar" className="min-w-0 max-sm:max-w-44" />
        </div>

        <TopNav pathname={pathname} projectSlug={projectSlug} />

        {/* Phones and tablets: min-w-0 lets the group narrow so its flex-wrap
            breaks the chips onto rows (no sideways scroll at 360px or 768px).
            From lg up it keeps shrink-0 so the account controls are never
            squeezed. */}
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 max-sm:gap-1 lg:shrink-0">
          <AgentsMenu pathname={pathname} agents={agents} points={userId ? points : null} />

          <div ref={accountRef} className="relative">
            <button
              ref={accountButtonRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={accountOpen}
              aria-controls="account-menu"
              onClick={() => setAccountOpen((open) => !open)}
              className={`inline-flex h-11 max-w-full items-center gap-2 rounded-full border border-zk-border bg-zk-surface py-[5px] pl-[5px] pr-3 text-zk-text hover:bg-zk-chip ${linkFocus}`}
            >
              <span className="sr-only">Account menu for </span>
              <Avatar name={userName} image={userImage} size="md" variant="solid" />
              {/* Phones show just the avatar; the name is still read out. */}
              <span className="max-w-40 truncate text-[13px] font-medium max-sm:sr-only">{userName}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="shrink-0 text-zk-muted max-sm:hidden">
                <path d={accountOpen ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6"} />
              </svg>
            </button>

            {accountOpen ? (
              <div
                id="account-menu"
                role="menu"
                aria-label="Account"
                className="absolute right-0 top-[54px] z-50 flex w-[300px] max-w-[calc(100vw-2rem)] origin-top-right flex-col gap-1 rounded-[20px] border border-zk-border bg-zk-surface p-2 shadow-[0_24px_56px_rgba(11,23,51,0.22)] motion-safe:animate-[header-pop_120ms_ease-out]"
              >
                <AccountSummary
                  userName={userName}
                  userImage={userImage}
                  realRole={realRole}
                />
                <MenuLink href="/settings/profile" active={isNavItemActive(pathname, "/settings/profile")}>
                  Profile
                </MenuLink>
                <AccountThemeSelector />
                <div className="mx-2 h-px bg-zk-divider" />
                <MenuLink href="/activity" active={isNavItemActive(pathname, "/activity")}>
                  Activity
                </MenuLink>
                {/* Every member can open the organization area; only owners and admins see its controls. */}
                {projectSlug ? (
                  <MenuLink href={orgPath(projectSlug)} active={Boolean(pathname?.startsWith(orgPath(projectSlug)))}>
                    Organization settings
                  </MenuLink>
                ) : null}
                {isSuperAdmin(role) ? (
                  <MenuLink href={SITE_ADMIN_HREF} active={isNavItemActive(pathname, SITE_ADMIN_HREF)}>
                    Site admin
                  </MenuLink>
                ) : null}
                <MenuLink href="/settings" active={isNavItemActive(pathname, "/settings")}>
                  Settings
                </MenuLink>
                <MenuLink href="/docs" active={isNavItemActive(pathname, "/docs")}>
                  Documentation
                </MenuLink>
                {reportFormUrl ? (
                  <MenuLink href={reportFormUrl}>Report issue</MenuLink>
                ) : null}
                <div className="mx-2 h-px bg-zk-divider" />
                <SignOutButton
                  userId={userId}
                  className={`${linkFocus} font-bold text-zk-bad-fg hover:bg-zk-bad-soft`}
                />
              </div>
            ) : null}
          </div>

          {/* Escalations, as an envelope, then the bell last. */}
          <InboxEnvelope key={`${userId}:${activeTenantId}:${pathname}`} unreadCount={unreadCount} pendingEscalations={pendingEscalationsCount} active={isNavItemActive(pathname, "/inbox")} />
        </div>
      </div>
    </header>
  );
}

function AccountSummary({
  userName,
  userImage,
  realRole,
}: {
  userName?: string | null;
  userImage?: string | null;
  realRole: AppRole;
}) {
  const roleLabel = realRole === "user" ? "Member" : roleViewLabels[realRole];
  return (
    <div className="flex items-center gap-3 rounded-[14px] bg-zk-tint p-3">
      <Avatar name={userName} image={userImage} size="lg" variant="solid" />
      <div className="min-w-0">
        <p className="truncate text-base font-extrabold text-zk-text">{userName}</p>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="rounded-full bg-zk-surface px-2 py-0.5 font-bold text-zk-text2">{roleLabel}</span>
        </p>
      </div>
    </div>
  );
}

function MenuLink({
  href,
  active = false,
  children,
}: {
  href: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  const external = href.startsWith("http");
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold ${linkFocus} ${
        active ? "bg-zk-tint text-zk-accent" : "text-zk-text hover:bg-zk-chip"
      }`}
    >
      {children}
    </Link>
  );
}
