"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";

export type PlatformTab = {
  /** A category id, `"none"`, or `null` for All. */
  id: string | null;
  name: string;
  count: number;
  href?: string;
  active?: boolean;
  icon?: ReactNode;
};

/**
 * #1055: the platform filter, as a dropdown on the right of the status tabs.
 * Every choice is a link, so the URL stays the source of truth.
 */
export function PlatformMenu({
  tabs,
  current,
  className = "",
  compact = false,
  iconOnly = false,
}: {
  tabs: PlatformTab[];
  current?: string | null;
  className?: string;
  /** In the search/filter/sort row: a 44px round button, icon-only on phones. */
  compact?: boolean;
  /** Just the platform icon, a dot when filtered; the choices open below it. */
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (tabs.length <= 1) return null;
  const selected = tabs.find((tab) => tab.active ?? tab.id === (current ?? null)) ?? tabs[0];
  const filtered = selected.id !== null;

  return (
    <div ref={rootRef} className={`relative shrink-0 ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
        aria-label={iconOnly ? `Platform: ${selected.name}` : undefined}
        title={compact || iconOnly ? `Platform: ${selected.name}` : undefined}
        className={`relative inline-flex items-center gap-2 border text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-electric-blue ${
          iconOnly
            ? "h-8 w-8 justify-center rounded-lg"
            : compact ? "h-8 rounded-lg text-[13px] max-sm:w-8 max-sm:justify-center sm:px-3" : "h-10 rounded-full px-4"
        } ${
          filtered
            ? "border-zk-accent bg-zk-tint text-zk-accent"
            : "border-zk-border bg-zk-surface text-zk-text hover:bg-zk-chip"
        }`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M8 20h8M12 16v4" />
        </svg>
        {iconOnly ? null : (
          <>
            <span className={compact ? "max-sm:sr-only" : ""}>
              Platform: <span className="font-semibold">{selected.name}</span>
            </span>
            <span className={`rounded-full bg-zk-chip px-1.5 font-mono text-xs tabular-nums text-zk-muted ${compact ? "max-sm:hidden" : ""}`}>{selected.count}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className={`text-zk-muted ${compact ? "max-sm:hidden" : ""}`}>
              <path d={open ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6"} />
            </svg>
          </>
        )}
        {(compact || iconOnly) && filtered ? (
          <span aria-hidden="true" className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-zk-surface bg-electric-blue-strong ${iconOnly ? "" : "sm:hidden"}`} />
        ) : null}
      </button>
      {/* Always rendered so the choices are real links in the page; hidden while closed. */}
      <nav
          id={menuId}
          aria-label="Platforms"
          hidden={!open}
          className={`absolute right-0 ${iconOnly ? "top-10" : "top-12"} z-30 w-60 max-w-[calc(100vw-2rem)] ${compact ? "max-sm:right-auto max-sm:left-1/2 max-sm:-translate-x-1/2" : ""} rounded-2xl border border-zk-border bg-zk-surface p-1.5 shadow-[0_16px_40px_rgba(11,23,51,0.16)]`}
        >
          <ul className="flex flex-col gap-0.5">
            {tabs.map((tab) => {
              const active = tab === selected;
              return (
                <li key={tab.id ?? "all"}>
                  <Link
                    href={tab.href ?? "#"}
                    aria-current={active ? "page" : undefined}
                    onClick={() => setOpen(false)}
                    className={`flex min-h-10 items-center gap-2 rounded-[10px] px-3 text-sm focus-visible:outline-2 focus-visible:outline-electric-blue ${
                      active ? "bg-zk-tint font-semibold text-zk-accent" : "font-medium text-zk-text hover:bg-zk-chip"
                    }`}
                  >
                    {tab.icon}
                    <span className="flex-1 truncate">{tab.name}</span>
                    <span className="font-mono text-xs tabular-nums text-zk-muted">{tab.count}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
      </nav>
    </div>
  );
}
