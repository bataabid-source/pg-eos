import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The DB-backed scenarios share one database with every other package's tests (ci.yml
    // --concurrency=1); one file at a time inside this package as well.
    fileParallelism: false,
    // issueSession/verifySessionSubject hash tokens with this secret (packages/identity); the same
    // test-only value packages/identity/vitest.config.ts sets — never a real secret.
    env: { OTP_HMAC_SECRET: 'test-only-not-a-secret-pg-eos-identity-suite' },
  },
});
