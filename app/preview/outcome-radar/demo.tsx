"use client";

import { useEffect, useState } from "react";
import { applyThemeClient } from "@/components/theme-toggle";
import { OutcomeRadar } from "@/components/overview/outcome-radar";

type Theme = "light" | "dark";

const themeLabel: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
};

/**
 * Minimal wrapper for the standalone preview: sets `data-theme` on <html> —
 * the same attribute the app's theme system uses (see app/theme-dark.css) —
 * so both palettes can be reviewed side by side without signing in.
 */
export function OutcomeRadarDemo() {
  const [theme, setTheme] = useState<Theme>("light");

  // Sync the preview's palette onto <html> via the app's own helper, the same
  // attribute the real theme system uses (see app/theme-dark.css).
  useEffect(() => {
    applyThemeClient(theme);
  }, [theme]);

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-4 p-4 sm:p-8" style={{ background: "var(--zk-bg)", minHeight: "100vh" }}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
            Design prototype preview
          </p>
          <p className="text-[13px] text-zk-muted">
            The sign-in view is <b className="text-zk-text">/dashboard</b>; this page exists so the
            two states can be reviewed without an account. Static prototype data only.
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
              aria-pressed={theme === option}
              onClick={() => setTheme(option)}
              className={`zk-motion rounded-full px-3 py-1 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue-strong ${
                theme === option
                  ? "bg-electric-blue-strong text-white"
                  : "text-zk-text hover:bg-zk-chip"
              }`}
            >
              {themeLabel[option]}
            </button>
          ))}
        </div>
      </header>
      <OutcomeRadar />
    </div>
  );
}
