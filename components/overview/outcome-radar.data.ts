/**
 * Fictional prototype data for the Outcome Radar.
 *
 * The Outcome Radar is a human→agent interaction design exploration: it shows
 * a signed-in human what their agents are doing towards one intended outcome,
 * and surfaces the single decision that needs a human call. Everything here is
 * invented sample data (issues #1390/#1412/#1427/#1436/#1441, agents
 * Mika/Atlas/Piper/Sweep) — none of these references exist in the product;
 * the component renders them verbatim and the UI labels them "fictional
 * prototype data". No backend or schema changes; moving to real data later
 * means feeding serialised `OutcomeRadarData` from the dashboard's server
 * queries — its props/type contract is designed for that.
 */

export type RadarTone = "ok" | "info" | "warn";

export type RadarSignal = { label: string; value: string };

export type RadarActivity = {
  id: string;
  agentName: string;
  action: string;
  /** Relative label — static so the prototype never reads hard-coded to "now". */
  when: string;
  tone: RadarTone;
};

export type RadarEvidence = {
  id: string;
  label: string;
  detail: string;
  /** Issue reference or otherwise linkable surface, display-only in the prototype. */
  href: string;
};

export type RadarTradeOff = {
  id: string;
  title: string;
  pros: string[];
  cons: string[];
};

export type RadarChoice = {
  id: string;
  label: string;
  description: string;
  /** What the agents start doing once the human confirms this choice. */
  effect: string;
};

export type RadarDecision = {
  id: string;
  title: string;
  question: string;
  dueLabel: string;
  riskLevel: "high" | "medium" | "low";
  riskSummary: string;
  riskDetails: string[];
  evidence: RadarEvidence[];
  tradeOffs: RadarTradeOff[];
  choices: RadarChoice[];
};

export type RadarOutcomeStatus = {
  tone: RadarTone;
  label: string;
};

export type RadarOutcome = {
  /** The human's own words for what they want to achieve. */
  intent: string;
  horizonLabel: string;
  status: RadarOutcomeStatus;
  signals: RadarSignal[];
};

export type OutcomeRadarData = {
  outcome: RadarOutcome;
  activities: RadarActivity[];
  decisions: RadarDecision[];
};

export const OUTCOME_RADAR_PROTOTYPE: OutcomeRadarData = {
  outcome: {
    intent:
      "Live on Friday: the agent offer flow on main, with the login outage patch still provable.",
    horizonLabel: "Release check · Fri, 17:00 WAT",
    status: { tone: "warn", label: "At risk — one decision is waiting on you" },
    signals: [
      { label: "Agents active", value: "3" },
      { label: "Issues moved today", value: "5" },
      { label: "Decisions waiting", value: "1" },
    ],
  },
  activities: [
    {
      id: "act-1",
      agentName: "Mika (merger)",
      action: "requested changes on #1441 — the failing login path has no regression test",
      when: "12 min ago",
      tone: "warn",
    },
    {
      id: "act-2",
      agentName: "Atlas",
      action: "green deployment check run for #1390 — 14 checks passed",
      when: "26 min ago",
      tone: "ok",
    },
    {
      id: "act-3",
      agentName: "Piper",
      action: "confirmed #1412 as a duplicate of #1427 and moved its voters over",
      when: "1 hr ago",
      tone: "info",
    },
    {
      id: "act-4",
      agentName: "Sweep",
      action: "released a stale claim on #1436 back to the board",
      when: "2 hrs ago",
      tone: "info",
    },
  ],
  decisions: [
    {
      id: "dec-1441",
      title: "#1441 · Login outage patch",
      question:
        "Hold #1441 until the regression test lands, or fast-track it into tonight's release check?",
      dueLabel: "Decision window closes in 4 hours · release check at 17:00",
      riskLevel: "high",
      riskSummary:
        "Fast-tracking ships the login fix without a guard, and may re-open the severity drift from #1408.",
      riskDetails: [
        "The failing path reproduces on production next.js only — CI is green without the test.",
        "Merging #1441 after 16:45 cuts the release-check window to under 15 minutes.",
        "Two of today's escalation reports cite the same signed-out symptoms.",
      ],
      evidence: [
        {
          id: "ev-1",
          label: "Merger rejection · Mika, 12 min ago",
          detail: "\"Requested changes — add a test that fails on the patched-out path.\"",
          href: "/issues/1441",
        },
        {
          id: "ev-2",
          label: "Deployment check · #1390",
          detail: "Latest run green across 14 checks, 26 min ago — tonight's base is safe.",
          href: "/issues/1390",
        },
        {
          id: "ev-3",
          label: "Escalation · #1427",
          detail: "\"Signed-out users bounce to login and back since 09:40\" — 3 reports.",
          href: "/escalations/1427",
        },
      ],
      tradeOffs: [
        {
          id: "wait",
          title: "Wait for the regression test",
          pros: [
            "Keeps the outage fix provable against the exact failing path",
            "Mika can re-review immediately — small risk of drift from #1408",
          ],
          cons: ["Tight: test + re-review must finish inside the 4-hour window", "Tonight's check slips to tomorrow if anything re-triggers"],
        },
        {
          id: "fast-track",
          title: "Fast-track into tonight's check",
          pros: [
            "Users stop hitting the login bounce today",
            "Frees tonight for the agent offer flow soak",
          ],
          cons: ["Ships without the guard test", "If the drift returns, the outage returns on the release branch"],
        },
      ],
      choices: [
        {
          id: "verify-first",
          label: "Verify first (hold the merge)",
          description: "Mika writes the regression test; merge waits for a green run.",
          effect: "hold #1441 until the regression test is green, then re-review",
        },
        {
          id: "fast-track",
          label: "Fast-track (accept the risk)",
          description: "Merge now; the test becomes a follow-up issue owned by Piper.",
          effect: "fast-track #1441 into tonight's release check and file the follow-up test",
        },
        {
          id: "bring-me-in",
          label: "Bring me in before deciding",
          description: "Agents pause and call you back with a live summary.",
          effect: "pause #1441 and prepare a live call-back summary for you",
        },
      ],
    },
  ],
};

/** The provenance line rendered under the radar on both surfaces. */
export const OUTCOME_RADAR_FOOTNOTE =
  "Fictional prototype data — issues, agents and verdicts are invented for this design, not live product information. Choices stay in this view; nothing is sent.";
