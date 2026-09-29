// tests/scenarios/playwright.config.ts — enablement item 3a (Master decision 1).
//
// `@playwright/test` is pinned exactly by the integration lane, enablement 3a, recorded in
// docs/CHANGELOG.md: its bundled Chromium 1194 is the pre-installed build
// (`/opt/pw-browsers/chromium-1194`) — a caret range let pnpm resolve a newer release bundling a
// different, not-pre-installed Chromium revision.
//
// Without PG_EOS_E2E the config is the bootstrap one: a single top-level testMatch (S1-S20), no
// `projects`, no `webServer`, no browser — the S-specs call the modules/wms handlers in-process, and
// G15 (⑤, nightly, local guards:run) runs exactly as before. With PG_EOS_E2E=1 (X part 5e) three
// projects exist — `scenarios` (unchanged, no browser), `host` (request fixture against the apps/api
// host on a TCP port) and `pda` (Desktop Chrome against the PDA Vite dev server) — and Playwright
// boots both servers. No `executablePath`: the pinned Chromium resolves through
// PLAYWRIGHT_BROWSERS_PATH locally and the CI install step.
//
// `workers: 1` and `fullyParallel: false` — S1 and S2 share one Postgres database
// (PGDATABASE=pgeos_lane3 in this lane) seeded/torn down per spec file; concurrent runs would
// collide on the same rows. This is deliberately NOT serial mode (`describe.serial`/`--workers=1`
// project-level "serial" semantics that stop a whole file after its first failure): every
// `test.step` inside a scenario still reports on its own, per Master decision 5 (a NOT BUILT step
// fails with a named message and later steps still run).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

// Named constants (CLAUDE.md — no magic numbers). Generous relative to typical handler latency:
// specs make several sequential DB round trips per scenario against a real Postgres instance.
const TEST_TIMEOUT_MS = 30_000;
const EXPECT_TIMEOUT_MS = 5_000;

// X part 5d: issueSession (mint, fixtures/actors.ts) and the host's own auth hook (apps/api/src/
// auth.ts) hash the session token with keyedHash (packages/identity/src/hmac.ts), which throws
// without OTP_HMAC_SECRET. The same test-only value apps/api's and packages/identity's own
// vitest.config.ts set (never a real secret); set here, before workers fork, so they inherit it.
// An environment that already provides the variable keeps its own value.
const OTP_HMAC_SECRET_ENV_VAR = 'OTP_HMAC_SECRET';
const TEST_ONLY_OTP_HMAC_SECRET = 'test-only-not-a-secret-pg-eos-identity-suite';
process.env[OTP_HMAC_SECRET_ENV_VAR] ??= TEST_ONLY_OTP_HMAC_SECRET;

// X part 5e — the e2e flag, ports (outside 3000/5173 so a running compose or dev server never
// collides), the app-role default (migration 0007) and the server start-up budget.
const E2E_FLAG_ENV_VAR = 'PG_EOS_E2E';
const E2E_FLAG_ON = '1';
const API_PORT_ENV_VAR = 'PG_EOS_API_PORT';
const PDA_PORT_ENV_VAR = 'PG_EOS_PDA_PORT';
const DEFAULT_API_PORT = '3901';
const DEFAULT_PDA_PORT = '5901';
const DEFAULT_PG_APP_USER = 'pgeos_app';
const WEB_SERVER_TIMEOUT_MS = 120_000;
const LOOPBACK_HOST = '127.0.0.1';
const HEALTH_PATH = '/health';
const API_PORT = process.env[API_PORT_ENV_VAR] ?? DEFAULT_API_PORT;
const PDA_PORT = process.env[PDA_PORT_ENV_VAR] ?? DEFAULT_PDA_PORT;
const API_URL = `http://${LOOPBACK_HOST}:${API_PORT}`;
const PDA_URL = `http://${LOOPBACK_HOST}:${PDA_PORT}`;
// `pnpm --filter` resolves from the workspace root, not from tests/scenarios.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const e2e = process.env[E2E_FLAG_ENV_VAR] === E2E_FLAG_ON;

const e2eProjects = [
  { name: 'scenarios', testMatch: /S\d{1,2}\.spec\.ts$/ },
  { name: 'host', testMatch: /host\/.*\.spec\.ts$/, use: { baseURL: API_URL } },
  {
    name: 'pda',
    testMatch: /pda\/.*\.spec\.ts$/,
    use: { ...devices['Desktop Chrome'], baseURL: PDA_URL },
  },
];

const e2eWebServers = [
  {
    command: 'pnpm -s --filter @pg-eos/api start',
    url: `${API_URL}${HEALTH_PATH}`,
    cwd: REPO_ROOT,
    env: { PORT: API_PORT, PG_APP_USER: process.env['PG_APP_USER'] ?? DEFAULT_PG_APP_USER },
    reuseExistingServer: !process.env['CI'],
    stdout: 'ignore' as const,
    stderr: 'pipe' as const,
    timeout: WEB_SERVER_TIMEOUT_MS,
  },
  {
    command: `pnpm -s --filter @pg-eos/pda dev --port ${PDA_PORT} --strictPort --host ${LOOPBACK_HOST}`,
    url: `${PDA_URL}/`,
    cwd: REPO_ROOT,
    reuseExistingServer: !process.env['CI'],
    stdout: 'ignore' as const,
    stderr: 'pipe' as const,
    timeout: WEB_SERVER_TIMEOUT_MS,
  },
];

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
  ...(e2e ? { projects: e2eProjects, webServer: e2eWebServers } : {}),
});
