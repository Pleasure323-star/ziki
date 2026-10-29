import type { Metadata } from "next";
import { OutcomeRadarDemo } from "./demo";

export const metadata: Metadata = {
  title: "Outcome Radar · design prototype",
  robots: { index: false, follow: false },
};

/**
 * Standalone, sign-in-free preview for the Outcome Radar design prototype.
 * Renders exactly the component the dashboard uses (`OutcomeRadar`) with its
 * prototype data, inside the real app shell, plus a small theme control so
 * reviewers can check the light and dark palettes. No auth, no database.
 *
 * `?theme=dark` and `?expanded=1` preselect the state and palette (used for
 * screenshot runs). They are read here, on the server, and passed down as
 * props so the server render agrees with hydration — no mismatch.
 */
export default async function OutcomeRadarPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ theme?: string; expanded?: string }>;
}) {
  const params = await searchParams;

  return (
    <OutcomeRadarDemo
      theme={params.theme === "dark" ? "dark" : "light"}
      initialExpanded={params.expanded === "1"}
    />
  );
}
