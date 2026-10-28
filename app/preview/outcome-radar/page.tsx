import type { Metadata } from "next";
import { OutcomeRadarDemo } from "./demo";

export const metadata: Metadata = {
  title: "Outcome Radar · design prototype",
  robots: { index: false, follow: false },
};

/**
 * Standalone, sign-in-free preview for the Outcome Radar design prototype.
 * Renders exactly the component the dashboard uses (`OutcomeRadar`) with its
 * prototype data, plus a small theme control so reviewers can check the light
 * and dark palettes. No app shell, no auth, no database access.
 */
export default function OutcomeRadarPreviewPage() {
  return <OutcomeRadarDemo />;
}
