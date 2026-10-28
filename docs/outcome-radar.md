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

## The two states

### State 1 — Dashboard overview

1. **Intended outcome** — the human's own words for the goal ("Live on Friday:
   the agent offer flow on main, with the login outage patch still provable"),
   a horizon chip (release check time), a status chip, and three signals
   (agents active / issues moved today / decisions waiting) for at-a-glance
   orientation.
2. **Agent activity (last 24 h)** — the relevant recent agent actions filtered
   to *this outcome's* scope, each tone-coded (ok / info / warn) so drift is
   visible without reading every line.
3. **Highest-priority decision** — a single banner (red-toned) with the
   decision question and its closing window, plus one prominent call to action
   (`Review decision`).

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
(`app/preview/outcome-radar/`) which renders the identical component with a
light/dark toggle, so the design can be reviewed without an account. It is
marked `noindex` and clearly labelled as a prototype preview.

## Tests

`components/overview/outcome-radar.dom.test.tsx` (Vitest + happy-dom) covers
both states: overview content, expansion (risk/evidence/trade-offs/choices
present), choice preview updates, confirm ("Choice recorded"), collapse via
button and Escape with focus restoration.
