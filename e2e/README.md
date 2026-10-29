# End-to-end tests

Playwright drives a production build in a real browser (#299). It covers:
- sign-in, a wrong password, and a deleted account's session;
- reporting an issue and finding it in the list;
- stage entries and replies to them, and older comments shown read-only;
- triage (status, severity, assignee), surviving a reload;
- deleting and restoring an issue;
- the admin screens;
- the same paths at 375px, with a check that no page scrolls sideways;
- the main pages against WCAG 2.x A/AA with axe (`a11y.spec.ts`).

## Run it locally

You need a **separate, empty database whose name says it's for tests**. The
seed wipes every table, and it refuses any database not named like
`bug_tracker_e2e` or `..._test`.

```bash
createdb bug_tracker_e2e
export DATABASE_URL=postgresql://bugtracker:bugtracker@localhost:5433/bug_tracker_e2e
pnpm exec prisma migrate deploy
pnpm e2e:seed
pnpm exec playwright install chromium   # once
AUTH_PASSWORD_LOGIN=true pnpm build
pnpm e2e        # starts `pnpm start` on :3000 itself
```

To test a server you already have running, set
`E2E_BASE_URL=http://localhost:3001`. Seed again before each run: the
suite creates issues and deletes one account.

When a test fails, it leaves a screenshot and a trace in `test-results/`.
Open the trace with `pnpm exec playwright show-trace <path>/trace.zip`.

## Writing a test

- `test.use({ as: "admin" })` signs the spec in as `user`, `admin` or
  `super`, or `null` for signed out. Sessions are created once by
  `auth.setup.ts`, because sign-in is rate limited.
- Desktop and mobile runs use different seeded accounts, so they don't
  share rate limits.
- Make titles with `uniq("...")` so parallel tests never see each other's
  issues.
- Prefer roles and labels (`getByRole`, `getByLabel`) to CSS selectors.
- For accessibility, call `expectNoA11yViolations(page)` from `./axe`
  after loading a page. It runs axe in the browser, so colour contrast is
  checked for real — something the jsdom tests in
  `components/a11y.test.tsx` cannot do.
