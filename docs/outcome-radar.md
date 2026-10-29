# Outcome Radar — design rationale

> HNG15 human–agent interaction design submission. Implemented as a prototype in
> the existing Ziki dashboard; no backend, schema, or API changes.

## What it is

The **Outcome Radar** answers one question for the human directing a fleet of
autonomous agents: *"Are my agents moving me toward the outcome I actually
want — and where do I need to step in?"*

It lives on the signed-in dashboard (`/dashboard`) as the lead section, above
the overview stat cards: the other cards describe *work* (points, assigned
issues); the radar describes *intent*, so the human reads it first.

The two states are strictly separate surfaces — no other screens, routes or
views were added. The dashboard integration and the standalone preview use the
same component.

## The two states

### State 1 — Dashboard overview

Ordered top to bottom by priority, so the human reads: intent → conflict →
context.

1. **Intended outcome** — the human's own words for the goal ("Live on Friday:
   the agent offer flow on main, with the login outage patch still provable"),
   a horizon chip (release check time), a status chip, and three signals
   (agents active / issues moved today / decisions waiting) for at-a-glance
   orientation.
2. **Highest-priority decision** — a single banner (red-toned) with the
   decision question and its closing window, plus one prominent call to action
   (`Review decision`).
3. **Agent activity (last 24 h) — secondary** — recent agent actions filtered
   to *this outcome's* scope, in compact tone-coded rows below the decision,
   so routine motion never competes with the call the human owes.

### State 2 — Expanded decision panel

Expanding in place (no modal, so context is never lost), the panel gives the
human everything needed to decide, in the order they need it:

- **Risk** — level chip (High/Medium/Low), one-sentence summary, and the
  specific reasons the risk exists.
- **Evidence** — the concrete artefacts behind the risk (merger rejection,
  deployment-check run, escalation), each with where it came from.
- **Trade-offs** — the two live options side by side as Pro/Con lists, written
  in the agents' own conflict rather than abstract pros/cons.
- **Your call** — a radio choice group ("how should the agents proceed?") with
  a live preview of what agents will *do* on confirm (`aria-live="polite"`),
  and a confirm action that records the choice ("Choice recorded ✓ · Agents
  will: …").

The human is always the actor: agents propose and surface, the human chooses,
and the panel spells out the consequence of each choice before it is
confirmed.

## Interaction & accessibility

- The banner button is the disclosure control (`aria-expanded`,
  `aria-controls`); the panel is an `role="region"` landmark focused on open.
- Escape or the `Collapse` button returns to the overview and restores focus to
  the banner trigger, matching the keyboard patterns used in
  `components/issue-filters.tsx`.
- While the panel is open, the banner compacts into a one-line strip
  ("Decision open · …"), so the decision question is never rendered twice on
  screen.
- Choice options are a `radiogroup`; the effect preview is a polite live
  region so screen readers hear the consequence of each option.
- Motion uses the existing `zk-motion` utility, which `prefers-reduced-motion`
  disables globally.

## Theming

Styling uses **only the shared `zk-*` theme tokens** (`--zk-bg`, `--zk-surface`,
`--zk-border`, `--zk-tint`, tone pairs `ok/warn/bad/info`, plus
`electric-blue-strong` for primary actions), which the existing
`app/theme-brand.css` / `app/theme-dark.css` system flips automatically between
light and dark. No new palette variables or `dark:` overrides were added, so
both themes keep working unchanged.

## Prototype data & scope

All figures come from `components/overview/outcome-radar.data.ts` — realistic,
domain-consistent sample data (issues #1390/#1412/#1427/#1436/#1441, agents
Mika/Atlas/Piper plus the claim sweep). The component is a client component
with local state only: **no Prisma queries, no API routes, no server actions,
no schema or validation changes**. Moving it to real data later would mean
feeding it serialised `OutcomeRadarData` from the dashboard's server queries —
its props/type contract is designed for that (`data?: OutcomeRadarData`).

A standalone, sign-in-free preview exists at **`/preview/outcome-radar`**
(`app/preview/outcome-radar/`) which renders the identical component so the
design can be reviewed without an account. It deliberately reproduces the
signed-in shell rather than a bare column: the real `AppHeader` (with clearly
marked sample identity/workspace/agents), the skip link, the shared
`PAGE_CONTAINER_CLASS` content width, the app's Inter typography via
`data-app-shell`, and a light/dark toggle. It is marked `noindex` and labelled
as a prototype preview with fictional data. `?theme=dark` and `?expanded=1`
preselect the palette and the expanded decision state for review and screenshot
runs; both are read in the server component and passed down as props so the
first server render agrees with hydration.

Screenshots of both states in both palettes, plus the test-run summary, live
under `delivery/` (`screenshots/outcome-radar-{overview,decision}-{light,dark}.png`
and `test-results.txt`).

## Tests

`components/overview/outcome-radar.dom.test.tsx` (Vitest + happy-dom) covers
both states: overview content and ordering, expansion (risk/evidence/trade-offs/
choices present), the question appearing exactly once while the panel is open,
choice preview updates, confirm ("Choice recorded"), collapse via button and
Escape with focus restoration.
