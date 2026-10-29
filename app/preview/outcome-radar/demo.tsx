"use client";

import { useEffect, useState } from "react";
import { AppHeader, type ShellAgent } from "@/components/app-header";
import type { AppRole } from "@/lib/roles";
import { applyThemeClient } from "@/components/theme-toggle";
import { MAIN_CONTENT_ID, SkipLink } from "@/components/skip-link";
import { PAGE_CONTAINER_CLASS } from "@/components/page-container";
import { OutcomeRadar } from "@/components/overview/outcome-radar";

type Theme = "light" | "dark";

const themeLabel: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
};

/** Sample identity for the preview header — no sign-in, no data. */
const sampleRole: AppRole = "user";
const sampleAgents: ShellAgent[] = [
  { id: "sample-piper", name: "Piper", level: "triager" },
  { id: "sample-mika", name: "Mika", level: "merger" },
];

/**
 * Preview wrapper for the standalone Outcome Radar review page. Reproduces the
 * signed-in shell (skip link, sample AppHeader, app container and Inter
 * typography via `data-app-shell`) so the design reads in its real context —
 * without auth or data. Sets `data-theme` on <html> via the app's own helper
 * (see app/theme-dark.css).
 *
 * Initial state arrives as props from the server page (which reads the query
 * params), so the server render agrees with hydration — no mismatch.
 */
export function OutcomeRadarDemo({
  theme,
  initialExpanded,
}: {
  theme: Theme;
  initialExpanded?: boolean;
}) {
  const [currentTheme, setTheme] = useState<Theme>(theme);

  // Sync the preview's palette onto <html> via the app's own helper, the same
  // attribute the real theme system uses (see app/theme-dark.css).
  useEffect(() => {
    applyThemeClient(currentTheme);
  }, [currentTheme]);

  return (
    <div data-app-shell="" className="flex min-h-screen flex-col bg-zk-bg">
      <SkipLink />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader
          userName="Alex Sample (prototype)"
          role={sampleRole}
          points={1400}
          targetPoints={500}
          agents={sampleAgents}
        />
        <main
          id={MAIN_CONTENT_ID}
          tabIndex={-1}
          className={`${PAGE_CONTAINER_CLASS} min-w-0 flex-1 overflow-x-clip py-6 outline-none max-sm:px-2 max-sm:pt-2.5 sm:px-6 sm:py-8`}
        >
          <div className="mx-auto flex max-w-[720px] flex-col gap-4">
            <header className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col">
                <p className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
                  Design prototype preview
                </p>
                <p className="text-[13px] text-zk-muted">
                  The preview header uses a sample identity and workspace. Static prototype data
                  only — choices stay in this view, nothing is sent.
                </p>
              </div>
              <div
                role="radiogroup"
                aria-label="Preview theme"
                className="flex items-center gap-1 rounded-full border border-zk-border bg-zk-surface p-1"
              >
                {(["light", "dark"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={currentTheme === option}
                    onClick={() => setTheme(option)}
                    className={`zk-motion rounded-full px-3 py-1 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue-strong ${
                      currentTheme === option
                        ? "bg-electric-blue-strong text-white"
                        : "text-zk-text hover:bg-zk-chip"
                    }`}
                  >
                    {themeLabel[option]}
                  </button>
                ))}
              </div>
            </header>
            <OutcomeRadar initialExpanded={initialExpanded} />
          </div>
        </main>
      </div>
    </div>
  );
}
