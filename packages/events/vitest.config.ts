import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // No `fileParallelism` override — vitest's default (parallel file execution) is left in place.
    // WBS 0.12 round 2 (pg-reviewer FAIL(16), findings 1/2) had set `fileParallelism: false` to
    // work around relay.ts's then-unscoped SELECT sweeping up unrelated pending rows across
    // concurrently-running test files. relayOnce(pool, opts) now accepts `opts.eventType`, and
    // every relayOnce() call in this suite passes an event_type suffixed with a fresh randomUUID()
    // per test run (review round 2, second pass, finding 1 — a hardcoded string only prevented
    // collision within one run, not against a concurrent worktree session on the same shared dev
    // database). That combination makes cross-file interference within a single run structurally
    // unreachable, so the explicit `fileParallelism: false` override was removed as no longer
    // needed. It does NOT make this suite safe against a genuinely concurrent RUN of relayOnce
    // itself outside this test process — see relay.ts's own header for that deferred limitation.
  },
});
