"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { selectTenantAction } from "@/app/(app)/tenants/actions";

/** A workspace the viewer belongs to and can open from the header. */
export type WorkspaceChoice = {
  id: string;
  name: string;
  slug: string;
};

function visibleName(workspace: WorkspaceChoice, shared: boolean): string {
  return shared ? `${workspace.name} (${workspace.slug})` : workspace.name;
}

/**
 * The active workspace in the header. The closed control is only as wide as
 * the current name. Choosing another one submits selectTenantAction, the same
 * switch the workspaces page uses. The accessible name includes the workspace
 * name on screen (WCAG 2.5.3); there is no aria-label to replace it.
 */
export function WorkspaceSwitcher({
  workspaces,
  activeTenantId,
  className = "",
  fullWidth = false,
  tone = "default",
  canManage = false,
}: {
  workspaces: WorkspaceChoice[];
  activeTenantId: string | null;
  /** The viewer administers the current workspace: link to its /org page. */
  canManage?: boolean;
  className?: string;
  fullWidth?: boolean;
  /** "chrome" paints the control for navy chrome. "bar" is the borderless switcher in the app top bar. */
  tone?: "default" | "chrome" | "bar";
}) {
  const chrome = tone === "chrome";
  const bar = tone === "bar";
  const listId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const counts = new Map<string, number>();
  for (const workspace of workspaces) {
    const key = workspace.name.toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const shared = (name: string) => (counts.get(name.toLocaleLowerCase()) ?? 0) > 1;
  const selected =
    workspaces.find((workspace) => workspace.id === activeTenantId) ?? workspaces[0];

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!selected) {
    return (
      <Link
        href="/tenants"
        className={`inline-flex h-8 items-center rounded-lg px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2 ${
          chrome
            ? "border border-surface-border bg-[#132347] text-porcelain hover:bg-[#1a2d57]"
            : "text-slate-700 hover:bg-slate-100 hover:text-slate-900"
        } ${fullWidth ? "w-full" : ""} ${className}`}
      >
        Workspaces
      </Link>
    );
  }

  const selectedLabel = visibleName(selected, shared(selected.name));

  function choose(id: string) {
    setOpen(false);
    if (id === selected?.id) return;
    const form = formRef.current;
    const input = form?.elements.namedItem("tenantId");
    if (!form || !(input instanceof HTMLInputElement)) return;
    input.value = id;
    form.requestSubmit();
  }

  return (
    <div ref={rootRef} className={`relative ${fullWidth ? "w-full" : "w-max max-w-40"} ${className}`}>
      <form ref={formRef} action={selectTenantAction}>
        <input type="hidden" name="tenantId" defaultValue={selected.id} />
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((current) => !current)}
          className={`inline-flex max-w-full items-center gap-2 border font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-tint focus-visible:ring-offset-2 focus-visible:ring-offset-deep-ocean ${
            bar
              ? "h-[30px] rounded-full border-transparent bg-transparent py-0 pl-1.5 pr-2.5 text-[13px] text-zk-text hover:bg-zk-chip max-sm:pl-0 max-sm:text-base max-sm:font-semibold"
              : chrome
                ? "h-9 rounded-full border-surface-border bg-white/[0.04] py-0 pl-3 pr-2 text-sm text-porcelain hover:bg-white/[0.08]"
                : "h-9 rounded-full border-slate-200 bg-card py-0 pl-3 pr-2 text-xs text-slate-800 hover:bg-slate-50"
          } ${fullWidth ? "w-full justify-between" : ""}`}
        >
          <span className="sr-only">Active workspace, </span>
          {chrome ? (
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
          ) : null}
          <span className="truncate">{selectedLabel}</span>
          <svg className={`h-3.5 w-3.5 shrink-0 ${chrome ? "text-sky-tint/70" : bar ? "text-zk-muted" : "text-slate-400"}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path
              fillRule="evenodd"
              d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        {open ? (
          <div
            className={`absolute left-0 top-full z-50 mt-1 rounded-lg border p-1 shadow-sm ${
              chrome ? "border-surface-border bg-[#142343]" : bar ? "w-60 rounded-2xl border-zk-border bg-zk-surface p-1.5 shadow-[0_16px_40px_rgba(11,23,51,0.16)]" : "border-slate-200 bg-card"
            } ${fullWidth ? "w-full" : bar ? "" : "w-max min-w-full max-w-56"}`}
          >
          <ul
            id={listId}
            role="listbox"
            aria-label="Workspaces"
            className="max-h-64 overflow-y-auto"
          >
            {workspaces.map((workspace) => {
              const label = visibleName(workspace, shared(workspace.name));
              const current = workspace.id === selected.id;
              return (
                <li key={workspace.id} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={current}
                    onClick={() => choose(workspace.id)}
                    className={`block w-full truncate rounded-md px-2 py-1.5 text-left ${bar ? "text-sm" : "text-xs"} ${
                      current
                        ? chrome
                          ? "bg-electric-blue/20 font-medium text-white"
                          : bar
                            ? "bg-zk-tint font-medium text-zk-accent"
                            : "bg-teal-50 font-medium text-teal-900"
                        : chrome
                          ? "text-slate-200 hover:bg-white/5"
                          : bar
                            ? "text-zk-text hover:bg-zk-chip"
                            : "text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    {label}
                  </button>
                </li>
              );
            })}
          </ul>
          {/* Outside the listbox: links, not options. Manage opens /org for the current
              workspace; Add opens the create form on the workspaces page. */}
          <div className={`mt-1 border-t pt-1 ${chrome ? "border-surface-border" : bar ? "border-zk-divider" : "border-slate-200"}`}>
            {canManage ? (
              <Link
                href="/org"
                onClick={() => setOpen(false)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${bar ? "text-sm font-medium text-zk-text hover:bg-zk-chip" : chrome ? "text-xs text-slate-200 hover:bg-white/5" : "text-xs text-slate-700 hover:bg-slate-50"}`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
                </svg>
                Manage organization
              </Link>
            ) : null}
            <Link
              href="/tenants#create-tenant"
              onClick={() => setOpen(false)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${bar ? "text-sm font-medium text-zk-accent hover:bg-zk-chip" : chrome ? "text-xs text-sky-tint hover:bg-white/5" : "text-xs text-teal-800 hover:bg-slate-50"}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Add organisation
            </Link>
          </div>
          </div>
        ) : null}
      </form>
    </div>
  );
}
