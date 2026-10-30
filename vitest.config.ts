import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node by default: most specs are pure logic or route handlers that need
    // Node's Request/FormData globals. Component specs opt into a DOM per file
    // with a `@vitest-environment jsdom` (or happy-dom) docblock.
    environment: "node",
    include: ["**/*.{test,spec}.{ts,tsx}"],
    // Only this checkout's unit tests. Setting `exclude` replaces Vitest's
    // defaults, so they are spread back in. Nested checkouts (agent worktrees
    // under .claude/worktrees or .worktrees) hold a whole second copy of the
    // suite and are never part of this one; nor are build output, generated
    // reports, Playwright specs (e2e, `pnpm e2e`), the standalone packages
    // (packages/*, their own install and tests in ci.yml) or the CLI scenarios
    // (cli/tests, `pnpm test:cli`). scripts/verify/discovery.test.ts checks it.
    exclude: [
      ...configDefaults.exclude,
      "**/.claude/**",
      "**/.worktrees/**",
      "**/.next/**",
      "**/coverage/**",
      "test-results/**",
      "playwright-report/**",
      "e2e/**",
      "packages/**",
      "cli/tests/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      // Unit-testable code only. app/** (server actions, API routes) needs a
      // live Prisma/DB and is out of scope for jsdom unit tests.
      include: ["components/**/*.{ts,tsx}", "lib/**/*.ts"],
      // Ratchet these upward as component backfill continues. As of ENDOR-219
      // actuals are ~56% lines (lib ~83%, components ~38%); the gap is
      // untested components like app-header/login-form, not this issue's scope.
      thresholds: {
        lines: 50,
        functions: 70,
        branches: 75,
        statements: 50,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(__dirname, "node_modules/server-only/empty.js"),
    },
  },
});
