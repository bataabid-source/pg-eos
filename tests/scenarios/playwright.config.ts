// tests/scenarios/playwright.config.ts — enablement item 3a (Master decision 1).
//
// `@playwright/test` is pinned exactly by the integration lane, enablement 3a, recorded in
// docs/CHANGELOG.md: its bundled Chromium 1194 is the pre-installed build
// (`/opt/pw-browsers/chromium-1194`) — a caret range let pnpm resolve a newer release bundling a
// different, not-pre-installed Chromium revision.
//
// Bootstrap only: the S1/S2 specs call the modules/wms handlers in-process (no `page`/`browser`
// fixture, no `projects` entry), so this config carries no `use.launchOptions` and no
// `executablePath` — nothing launches a browser yet. A browser project is added with the first
// PDA screen (Master decision 1).
//
// `workers: 1` and `fullyParallel: false` — S1 and S2 share one Postgres database
// (PGDATABASE=pgeos_lane3 in this lane) seeded/torn down per spec file; concurrent runs would
// collide on the same rows. This is deliberately NOT serial mode (`describe.serial`/`--workers=1`
// project-level "serial" semantics that stop a whole file after its first failure): every
// `test.step` inside a scenario still reports on its own, per Master decision 5 (a NOT BUILT step
// fails with a named message and later steps still run).
import { defineConfig } from '@playwright/test';

// Named constants (CLAUDE.md — no magic numbers). Generous relative to typical handler latency:
// specs make several sequential DB round trips per scenario against a real Postgres instance.
const TEST_TIMEOUT_MS = 30_000;
const EXPECT_TIMEOUT_MS = 5_000;

export default defineConfig({
  testDir: '.',
  testMatch: /S\d{1,2}\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env['CI'],
  reporter: [['list']],
  timeout: TEST_TIMEOUT_MS,
  expect: {
    timeout: EXPECT_TIMEOUT_MS,
  },
  outputDir: 'test-results',
});
