import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // OTP_HMAC_SECRET is the ONLY env var this package adds on top of the PG* convention every
    // other package already shares (packages/db/src/client.ts). The WBS 0.17 brief requires the
    // OTP-code and session-token hashes to be a KEYED HMAC ("never a plain unsalted hash — a
    // 6-digit OTP is a 1e6-space, brute-forceable under a bare SHA-256 lookup if the table ever
    // leaked"), and that the key come from an env var with "tests supply their own fixed test
    // value, never a hardcoded production-shaped secret".
    //
    // It is set HERE, in the vitest config, and not in a beforeAll(): the implementation may read
    // process.env at module scope, which is evaluated when a test file's static imports resolve —
    // strictly before any test-file body or hook runs. `test.env` is applied before the test files
    // load, so it works whether the implementation reads the secret eagerly or lazily.
    //
    // The value is deliberately self-describing and obviously not a credential: it must never be
    // mistaken for, or promoted to, a real secret. Production supplies the real one through the
    // deployment environment; no default belongs in code.
    env: {
      OTP_HMAC_SECRET: 'test-only-not-a-secret-pg-eos-identity-suite',
    },
    // No `fileParallelism` override — vitest's default (parallel file execution) stands, matching
    // packages/events/vitest.config.ts. Every row these three suites touch is keyed by a
    // randomUUID()-suffixed fixture value (emails, permission codes) or by a fixture user id, so
    // no suite can see another suite's rows, in this run or in a concurrently-running worktree
    // session against the same shared dev database. The one shared-key exception is the
    // platform.thresholds fixture rows — see the header of each suite that seeds them.
  },
});
