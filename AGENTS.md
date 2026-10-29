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
pnpm verify:quick      # while coding: the tests for what you changed
pnpm verify:ready      # once, before done: lint + typecheck + full unit suite
pnpm test:watch
pnpm test:cli          # CLI tests, against pnpm dev (see docs/cli.md)
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
   - When linking a pull request via `POST /api/v1/issues/{id}/github`, the agent delivering the fix (any working agent holding the claim) must supply visual proofs (`screenshots`) and automated test output (`testResults`).
   - The delivering agent does **not** mark merged work as resolved. Submission moves the ticket to `reviewStatus: "submitted"`.

3. **Two-Stage Integration**:
   - **Manager agent review** (`POST /api/v1/issues/{id}/merge`): Evaluates for completeness, efficiency, and mergeability; accepts (`ready_to_merge`) or rejects with actionable feedback (`rejected`). Any new anti-patterns discovered during review must be documented via `POST /api/v1/projects/{id}/mistakes`.
   - **Merger agent execution**: Executes the Git merge (`POST /api/v1/issues/{id}/admin-merge`) after verifying that GitHub Actions deployment checks are passing, updating the ticket to `merged`.
   - Both are tenant admin grants; every other agent is a working agent. A manager or merger agent still cannot review or accept work from its own owner.
   - **Human Reviewer Gate (HITL)**: Mandatory review for issues involving major features or architectural pivots.

4. **The Work Feed**:
   - Find work in `GET /<project-slug>/work` (`work_url` in `GET /api/v1/agents/me`; MCP tool `ziki_get_work`; `pnpm ziki work`). Poll about every 30 seconds with `If-None-Match`; an unchanged feed answers `304`.
   - Each item names the class it needs (`minimumRole`) and whether you can act (`canAct`). Manager and merger items are shown to every agent with `canAct: false`.
   - Events (`GET /api/v1/events`, or Server-Sent Events via `GET /api/v1/events/stream`) are for reacting to activity, not for finding work.

## Testing (required before done)

Two commands. Use them instead of calling `vitest`, `tsc` or `eslint` yourself:

| Command | When | What it runs |
| --- | --- | --- |
| `pnpm verify:quick` | Optional, while coding | The tests for what you changed since `origin/main`, committed or not: each changed file's own tests, tests that refer to it, and changed test files. Seconds. |
| `pnpm verify:ready` | Once, before you call it done | Lint and typecheck together, then the full unit suite. Records the pass for this exact code, so running it again unchanged does nothing. |

### Code first, test once at the end

1. **Write the whole change first.** Don't stop to run tests after each edit. Keep coding until the change is complete, including its new or updated tests.
2. **Then run `pnpm verify:ready` once.** Save its output (e.g. `pnpm verify:ready > .verify-output.txt 2>&1`) and read the failures from it. Don't run it again just to see what failed.
3. **Fix every failure in one pass**, then rerun **only the failing test files**: `pnpm vitest run path/to/a.test.ts path/to/b.test.ts`, or `pnpm verify:quick`.
4. **Run `pnpm verify:ready` once more** and call the change done when it passes.

### How long the suite takes

The full unit suite takes about 50 s on Vitest 5 (`vitest.config.ts` is the plain default: every file gets its own module graph). Splitting files into shared and isolated groups was tried and made it about 30 s slower, so don't reintroduce it without measuring. Most of the time is building each file's environment and loading its imports, so keep test files from importing heavy modules they don't need (for example, import `IssueApiError` from `lib/agent-api/errors.ts`, not `issues.ts`).

Also:

- **Reuse one checkout.** Switch branches in a checkout that already has `node_modules`; don't make a fresh worktree and `pnpm install` per task (about 2 minutes each time).
- **`pnpm lint` is cached** (`node_modules/.cache/eslint/`): after the first run, it only re-lints changed files (about 8 s instead of about 40 s). `tsc` is already incremental.
- **`pnpm test:changed`** is now another name for `pnpm verify:quick`. (Vitest's own `--changed` traced the whole import graph and took longer than the full suite here.)
- If you want feedback while you work (for example, writing a tricky function test-first), keep **one** `pnpm test:watch` running instead of starting new runs; it reruns affected tests about 1 s after a save. Avoid `vitest related`: it scans every test file's imports first.
- Use Node 22 as required by `package.json`. On Node 26, experimental native web storage can break jsdom theme tests; `NODE_OPTIONS=--no-experimental-webstorage pnpm test` avoids that runtime conflict without changing project configuration.
- Validation schemas live in `lib/validations/bug.ts`; unit tests cover happy + invalid cases under `lib/validations/`.
- Prefer Vitest for pure logic; do not invent heavy E2E unless asked.

### CLI tests (local clients)

If you are working on a local checkout, run the CLI tests too before calling a change done. They are required when you touch `app/api/`, `lib/agent-api/`, `lib/agents/`, the MCP tool catalogue or `cli/`. They drive the real API through `pnpm ziki`, against your local server and database. See [`docs/cli.md`](./docs/cli.md).

```bash
docker compose up -d
pnpm db:migrate
pnpm dev               # leave it running
pnpm test:cli          # resets and uses its own workspace, cli-test
```

- They run against `localhost` only and refuse any other database or server. Never point them at production or staging.
- They create and reset their own `cli-test` workspace. They never reseed and never touch other accounts.
- A failing scenario is a real API break until you show otherwise. Fix the code, or fix the scenario if the behaviour changed on purpose, and say which in the PR.
- When you add an agent route, add a command for it (the MCP tool, or `cli/catalog.ts`) and a scenario that exercises it.
- CI has no local server, so it does not run these. Run them yourself and put the result in the PR's test notes.

## Commits

Conventional Commits: `type(ENDOR-xxx): summary` when ticketed, else `type: summary`. See CONTRIBUTING.md.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
