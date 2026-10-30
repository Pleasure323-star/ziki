# AGENTS.md

Instructions for AI coding agents working on **Ziki Issues** (HNG15 Task 1).

**Agent API Reference:** [`docs/ziki-for-agents.md`](./docs/ziki-for-agents.md) — Ziki agent API, agent classes, points, and safety rules.

Production code lives in [`emerjent/ziki`](https://github.com/emerjent/ziki) (renamed from `emerjent/bug-tracker`, formerly `zeduchat/bug-tracker`; the old `Zedu-Endor/issue-tracker` fork no longer exists). Production runs at `https://ziki.dev` (served from root; the old `issues.zedu.chat` host still works), with legacy `/bug-tracker` compatibility preserved.

**Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first.** It is the source of truth for branches, commits, PRs, and local setup. This file adds agent-specific guidance.

## Stack

- Next.js App Router + React 19 + TypeScript + Tailwind CSS
- Prisma + PostgreSQL (`docker compose`)
- Auth.js (NextAuth v5) — credentials + optional Google
- Zod validation in `lib/validations/`
- Package manager: **pnpm only**
- Deploy: Dockerfile → Coolify (malware CI gate on `main`)

## Hard rules

- Work on a feature branch; PRs target **`main`** on `emerjent/ziki` only (not `zedu-hng` or product repos).
- Never force-push (`--force`, `-f`, `--force-with-lease`).
- Never commit `.env`, secrets, keys, or credential JSON.
- Keep changes scoped to the ticket / request — no drive-by refactors.
- Do not overwrite unrelated in-progress app work; prefer additive edits.
- One logical change per PR when practical.
- **Never reseed the shared/local demo DB** if teammates (or you) have created real accounts. `pnpm db:seed`, `prisma db seed`, `pnpm db:reset`, and `prisma migrate reset` wipe users and related data. Prefer **migrations only** (`pnpm db:migrate` / `prisma migrate deploy`). Seed is for **empty first-time setup only**.

## Layout

| Path | Holds |
| --- | --- |
| `app/` | App Router routes, `(app)` / `(auth)` groups, `actions/`, `api/` |
| `components/` | UI components |
| `lib/` | Prisma client, auth helpers, formatters, `validations/` |
| `prisma/` | Schema, migrations, seed |
| `types/` | Shared TypeScript types |

## Commands

```bash
pnpm install
docker compose up -d
cp .env.example .env   # never commit .env
pnpm db:migrate
# pnpm db:seed   # ONLY on empty first-time setup — never if real signups exist
pnpm dev               # http://localhost:3001
pnpm verify:ready      # once, after the whole change: lint + typecheck + full unit suite
pnpm verify:recheck    # after repairs: failing tests + tests affected by the repairs
pnpm verify:status     # what the full run and the rechecks covered
pnpm test:cli          # only for agent API changes (CI runs it on every PR)
pnpm build
```

> **DB safety:** Do not run `db:seed` / `db:reset` against a DB that already has teammate accounts. Migrations only.

## Autonomous Multi-Agent SDLC Workflow

Ziki uses an autonomous multi-agent software engineering lifecycle. Follow these guidelines:

All agents watch their project's work feed, `GET /<project-slug>/work`, about every 30 seconds. It is the one place work appears.

Every new report is an idea (`POST /api/v1/ideas`). An idea is not an issue: ideas have their own table, numbers and routes. People and agents give it one verdict each (good, bad or neutral) with `POST /api/v1/ideas/{id}/verdicts`; ideas take no importance marks or comments. When its score reaches the project's `ideaThreshold`, a manager agent converts it (`POST /api/v1/ideas/{id}/convert`), which creates the issue in status `requires_confirmation`. Once independent reviewers confirm it, it is `open` and waits for bids, an offer request or a dispatch.

1. **Consult the Mistake Registry First**:
   - Before implementing a task, query known anti-patterns via `GET /api/v1/projects/{id}/mistakes` (or MCP tool `ziki_get_project_mistakes`) to avoid repeating documented mistakes.

2. **Submission Evidence**:
   - The agent holding the claim delivers its work with `POST /api/v1/issues/{id}/delivery`: the pull request, a summary, a description, and visual proofs (`screenshots`) or automated test output (`testResults`).
   - The delivering agent does **not** mark merged work as resolved. Delivering moves the ticket to `delivered`. An issue has one `status`, one pipeline step each: `requires_confirmation` → `open` → `in_progress` → `delivered` → `done` → `ready_to_merge` → `resolved` (Live), or `closed`. Letting go of a claim after delivering leaves the issue where the work got to.

3. **Testing, review and merge** (each step's decision is that step's entry, see "The issue model" below):
   - **Testers** judge the delivered work (`POST /api/v1/issues/{id}/test-results`: `goodToMerge`, `summary`, `description`). Once the project's required independent judgements say good to merge, the issue moves to Done (`done`) on its own; once that many say not good to merge, it goes back to Open (`open`).
   - **Manager agent review** (`POST /api/v1/issues/{id}/merge`): a merge review entry, `verdict` accept or reject, with a `summary` and a `description`. Accept moves it to Ready to Merge (`ready_to_merge`); reject sends it back to In progress (`in_progress`) and puts the feedback the author acts on in the description. Any new anti-pattern found in review goes to `POST /api/v1/projects/{id}/mistakes`.
   - **Merger agent execution**: Executes the Git merge (`POST /api/v1/issues/{id}/admin-merge`) after verifying that GitHub Actions deployment checks are passing, updating the ticket to `resolved` (the Live tab).
   - Manager and merger are tenant admin grants; every other agent is a working agent. A manager or merger agent still cannot review or accept work from its own owner.
   - **Human Reviewer Gate (HITL)**: Mandatory review for issues involving major features or architectural pivots.

4. **The Work Feed**:
   - Find work in `GET /<project-slug>/work` (`work_url` in `GET /api/v1/agents/me`; MCP tool `ziki_get_work`; `pnpm ziki work`). Poll about every 30 seconds with `If-None-Match`; an unchanged feed answers `304`.
   - Each item names the class it needs (`minimumRole`) and whether you can act (`canAct`). Manager and merger items are shown to every agent with `canAct: false`.
   - Events (`GET /api/v1/events`, or Server-Sent Events via `GET /api/v1/events/stream`) are for reacting to activity, not for finding work.

## The issue model (don't rebuild the old one)

These are product rules. Code, docs and UI follow them; a change that brings back the old shape is wrong even if it passes the tests.

- **Ideas are not issues.** They have their own table, numbers (idea #1, #2, … apart from issue numbers), routes (`/api/v1/ideas`) and page. An issue exists only by converting an idea; nothing files an issue directly.
- **One status per issue.** Requires confirmation → Open → In progress → Delivered → Done → Ready to Merge → Live, plus Closed. Don't show a second status-like label next to it (no separate "stage" chip, no per-stage tally line under a row). Nobody sets a status by hand; it moves as agents do the work.
- **One entry per person per step.** At each step a person or agent gives exactly one top-level entry for that step, with a verdict, a `summary` (at most two sentences) and a full `description`. A newer entry from the same person replaces theirs.

  | Step | Entry |
  | --- | --- |
  | Idea | idea verdict: good, bad or neutral |
  | Requires confirmation | confirmation: confirm, reject or neutral |
  | Open | bid |
  | In progress | delivery ("Work delivered"), by the agent holding the claim |
  | Delivered | judgement (test verdict): good to merge or not |
  | Done | merge review: accept or reject |

- **Replies, and comments only while Open.** A comment is a plain-text reply under one entry, or, while the issue is Open, a comment on the issue itself or a one-level reply to one (`lib/comment-placement.ts` is the one rule). There are no typed comments, and no comment that repeats a decision already recorded as an entry: the entry's description is the record.
- **Who has the issue is its claim.** `IssueClaim` is the one record of who holds the work (bid award, offer, assignment); the issue page's award box reads it.
- **Importance is a toggle.** Marking an issue important is a plain yes or no, for people and agents, with no reason or comment attached.
- **One way to do each thing.** When the model changes, remove the old route, field or value outright. Don't keep aliases, deprecated fields or retired-route shims for old clients.

## Testing (required before done)

The sequence is: **complete the implementation → collect every failure once → fix them together → recheck what changed → CI is the release gate.**

| Command | When | What it runs |
| --- | --- | --- |
| `pnpm verify:ready` | Once, when the whole change is written | Lint, typecheck and the full unit suite. Every phase runs and reports even if another fails. Each phase keeps a complete log under `node_modules/.cache/verify/runs/`. The summary gives each phase's time, exit code, test counts and log path, and exits nonzero if any phase failed or couldn't run. `pnpm check` is the same command. |
| `pnpm verify:recheck` | After you fix what the full run found | The full run's failing test files, plus every unit test whose imports reach a file changed since that run. Lint runs only on the changed files and the files that failed lint; typecheck runs only if TypeScript or config changed or typecheck had failed. It is never a second full run unless one is needed (below). |
| `pnpm verify:status` | Before you report | What the last full run covered (revision, input state, results, durations, logs), each recheck since, and whether the current files match either. Report from this. |

### 1. Implement without running checks

1. **Write the whole change first**, including its new or updated tests. Don't run tests, typecheck, lint, builds, `verify:quick` or watch mode between edits, and don't run a baseline suite before you start.
2. While coding, read the code and use the diagnostics your editor already shows.
3. **One exception:** when a specific uncertainty blocks the implementation (how a library behaves, what a function returns today), you may run the smallest check that answers it, such as one test file or one `node -e`. Say what question it answers.
4. Reuse this checkout and its installed `node_modules`. Don't make a fresh worktree and run `pnpm install` per task (about 2 minutes each time).

Running tests later doesn't mean fewer tests: never delete a test or weaken an assertion to get a pass.

### 2. Verify once, then fix everything together

1. Run `pnpm verify:ready` once. Read every failure from its summary and logs. Don't rerun a command to see output its log already holds.
2. Fix all of the failures in one pass.
3. Run `pnpm verify:recheck`. Repeat steps 2 and 3 only for what the recheck still finds.
4. **Don't run the full suite again on your own.** `verify:recheck` turns into a full run by itself, and says why, when the affected tests can't be worked out from imports:
   - a shared input changed: `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, `tsconfig*.json`, `eslint.config.*`, `next.config.*` or `prisma/schema.prisma`;
   - the environment changed: Node version, installed dependencies, the generated Prisma client, or a variable it hashes such as `NODE_OPTIONS`, `TZ` or `DATABASE_URL`.

   Run another full `verify:ready` yourself only for a concrete reason of that kind, and say what it is.

### 3. Report what each run actually covered

Results are keyed by the input state, which covers:

- every tracked and untracked file, by content (after `.gitignore`);
- the Node version and platform;
- the installed dependencies and the generated Prisma client;
- a hash of the environment variables above.

A pass is reused only for exactly that state. Logs live under `node_modules/.cache`, so writing them never changes the state. In the PR's test plan, separate:

- the **full run**: its revision and input state, and its result;
- the **repairs** made after it;
- the **targeted rechecks** after the repairs, and what they reran;
- **CI** on the final commit.

Don't describe a recheck as a full pass of the final code. Don't count a known failure as a pass either: report it separately, with its evidence. A test may be quarantined only explicitly, narrowly (one test, with the reason and an issue link in the code) and in the PR.

### Test discovery

`pnpm test` and `verify:ready` find only this checkout's unit tests. `vitest.config.ts` excludes:

- nested checkouts (`.claude/worktrees/`, `.worktrees/`, at any depth);
- dependencies and build output;
- Playwright specs (`e2e/`, run with `pnpm e2e`);
- the standalone `packages/*`, which have their own install and tests in CI;
- the CLI scenarios (`cli/tests/`, run with `pnpm test:cli`).

`scripts/verify/discovery.test.ts` checks this with Vitest's own file listing. Don't work around a discovery problem with command-line `--exclude` flags; fix the config.

### How long it takes

The unit suite runs every file with its own module graph (Vitest's default isolation). Splitting files into shared and isolated groups was tried; it introduced failures and made the suite about 30 s slower, so don't change isolation or the worker pool without a passing, measured comparison. Most of the time is building each file's environment and loading its imports, so keep test files from importing heavy modules they don't need (for example, import `IssueApiError` from `lib/agent-api/errors.ts`, not `issues.ts`). `verify:ready` runs lint and typecheck side by side, then the suite on its own (`--schedule split`, the default). Measured warm on a 24-CPU Windows machine (one run each), a full run took 69 s split (lint 10 s and typecheck 10 s together, then the suite 59 s) and 66 s with all three at once (`--schedule parallel`), where contention slowed every phase (the suite to 66 s). That is no clear win, so the default stays split. Measure again before changing it.

Also:

- **`pnpm lint` is cached** (`node_modules/.cache/eslint/`) and `tsc` is incremental, so a recheck of either is quick.
- Use Node 22, as `package.json` requires. On Node 26, experimental native web storage can break jsdom theme tests; `NODE_OPTIONS=--no-experimental-webstorage pnpm verify:ready` avoids that without changing project configuration.
- Validation schemas live in `lib/validations/` (issues in `issue.ts`); unit tests cover happy + invalid cases beside them.
- Prefer Vitest for pure logic; do not invent heavy E2E unless asked.

**Diagnostic commands (exceptions, not the default sequence):**

- `pnpm verify:quick`: the tests affected by everything that differs from `origin/main`.
- `pnpm vitest run <file>`: one file, for the blocking-uncertainty case above.
- `pnpm test:watch`: watch mode, only for test-first work on one tricky function.

Use them only for a specific question.

### CLI tests (only for API changes)

The CLI scenarios drive the real agent API through `pnpm ziki`. **CI runs them on every PR** (the `CLI scenarios` job, with its own database and server), so a local run is not part of every change.

Run them locally only when either is true:

- the change affects the API contracts or behaviour they exercise: `app/api/`, `lib/agent-api/`, `lib/agents/`, the MCP tool catalogue, `cli/`, or a migration those routes depend on;
- you need them to diagnose a specific integration problem.

Don't start a server or database for documentation-only or unrelated UI changes. See [`docs/cli.md`](./docs/cli.md).

```bash
docker compose up -d   # the local Postgres
pnpm test:cli          # or: pnpm test:cli lifecycle
```

`pnpm test:cli` handles the server:

- It reuses this checkout's healthy `pnpm dev` if one is running and started after `.env` and the Prisma client last changed. Otherwise it starts `next dev` once.
- It waits at most 90 s for the server to be ready (`--ready-timeout`). On timeout it prints what the health check saw and the end of the server log.
- It stops only the server it started.
- Exit code 3 means no usable server; nothing ran, or the server went away mid-run. Exit code 1 means scenarios failed.

Rules for the scenarios themselves:

- They run against `localhost` only and refuse any other database or server. Never point them at production or staging.
- They rebuild only their own `cli-test` workspace. They never seed, reset or migrate a database, and never touch other accounts.
- A failing scenario is a real API break until you show otherwise. Fix the code, or fix the scenario if the behaviour changed on purpose, and say which in the PR.
- When you add an agent route, add a command for it (the MCP tool, or `cli/catalog.ts`) and a scenario that exercises it.

## Migrations

- **Migrations only, never a reseed or reset** (see Hard rules). Production applies them at container start (`scripts/migrate.mjs`), so a migration that fails takes the deploy down with it.
- **A new enum value goes in its own migration.** Postgres can't use a value in the transaction that adds it, so `ALTER TYPE … ADD VALUE` is one migration and any default or backfill that uses the value is the next.
- **Moving rows: unhook cascades before deleting.** A migration that copies rows to a new table and then deletes the old ones must first drop or repoint every foreign key that cascades from them. Deleting the old rows otherwise deletes what hangs off them (this once lost 9 of 14 idea verdicts in a test run).
- **Write a data migration's rule in SQL the same way the app decides it**, then check it: run it on a copy and compare row by row against the app's own function (for example `isConfirmed()`). Expect 0 mismatches.
- **Test on a copy, never the shared dev database.** Copy it with `pg_dump` into a scratch database on the same server, point `DATABASE_URL` at the copy, run `pnpm exec prisma migrate deploy`, check the data, then drop the copy. Never run `prisma migrate dev`, `migrate reset` or anything that uses a shadow database against the dev database. To see the SQL a schema change needs, diff the two schema files: `pnpm exec prisma migrate diff --from-schema-datamodel <old.prisma> --to-schema-datamodel prisma/schema.prisma --script`.

## Merging and deploying

- **Check mergeability first.** `gh pr view <n> --json mergeable` must be `MERGEABLE`. A conflicting PR runs no checks and the merge is refused, so waiting on CI is pointless until the branch is brought up to date with `main`.
- **Merge only on green**, and only with explicit approval from the person you work for: every check passes on the final commit, including End-to-end (Playwright) and CLI scenarios.
- **Live means the commit is served.** After merging, `main`'s CI runs again, then Coolify deploys (about 3–4 minutes) and the migrations run at container start. It is live when `https://ziki.dev/api/health` reports the merge commit's SHA. Compare against that SHA; an empty or unknown SHA must never count as live.
- **Deploy status:** `COOLIFY_READ_KEY` and `COOLIFY_ADDRESS` in `.env` read Coolify's API (`/api/v1/deployments/applications/<uuid>`) for a deploy's status. They are read-only; never print the key.
- **Production data is read-only.** Never write to the production database; read queries only, and only when the person you work for allows it.

## Commits

Conventional Commits: `type(ENDOR-xxx): summary` when ticketed, else `type: summary`. See CONTRIBUTING.md.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
