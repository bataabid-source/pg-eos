// tests/isolation/vitest.config.ts — WBS 0.18 (pg-tester).
//
// Mirrors packages/db/vitest.config.ts (the brief's explicit instruction), with two additions this
// suite specifically needs and packages/db's does not:
//   - `testTimeout: 30_000` — a single beforeAll here provisions a live Postgres role (terminate
//     backends, drop owned, drop role, create role, two schema/table GRANTs) and seeds 10 rows
//     across 5 tables for two clients, all as real round-trips to the dev database. Vitest's 5s
//     default is too tight for that against a cold connection pool.
//   - `fileParallelism: false` — the role name (`pgeos_rls_isolation_test`) is a single fixed,
//     shared name (the brief pins it, not a per-run random suffix), so two files creating/dropping
//     it concurrently would race. There is only one spec file in this package today, but this stays
//     set so a second file added later inherits the same safety instead of silently racing.
//   - Same "a second file added later" caveat applies to `process.env['PGUSER']` /
//     `process.env['PGPASSWORD']`: client-isolation.test.ts mutates both at module top level (to
//     connect its `withContext` calls as the throwaway role instead of the superuser default) and
//     restores the originals in its own `afterAll`. Because vitest reuses one worker process per
//     package, `process.env` survives module-registry isolation between spec files in the SAME
//     run — a second file would otherwise see whatever this file's mutation left behind. The
//     restore-in-afterAll (see that file's ORIGINAL_PGUSER/ORIGINAL_PGPASSWORD comment) is what
//     makes that safe; `fileParallelism: false` only serializes them, it does not by itself prevent
//     the leak.
//   - `fileParallelism: false` (and the timeout above) only protect files WITHIN one process/run.
//     They do nothing for two SEPARATE `pnpm test:isolation` invocations (e.g. two worktrees) run
//     concurrently against the same database. That is a different problem, solved separately in
//     client-isolation.test.ts itself (review round 3, FIX 4): its `beforeAll`/`afterAll` take and
//     release a `pg_advisory_lock` on the superuser connection so two full runs serialize instead
//     of one run's fixture sweep deleting the other's live rows. See that file's
//     `ADVISORY_LOCK_NAME` comment for the full rationale.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
