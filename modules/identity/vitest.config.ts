import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts', 'tests/otp-login/**/*.test.ts'],
    environment: 'node',
    // Doc 36 §5-5 / CLAUDE.md · TESTING: domain/ unit coverage ≥ 90 %, enforced on every run
    // (ADR-0005 §6). Pre-commit's partial runs pass --coverage.enabled=false.
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['domain/**'],
      reporter: ['text-summary'],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
    // Same fixed, self-describing test value as packages/identity/vitest.config.ts: the WBS 0.17
    // mechanism (@pg-eos/identity-mechanisms) keys its OTP/session hashes with OTP_HMAC_SECRET and
    // has no default. Set here (not in a beforeAll) so it is in place before any import resolves.
    env: {
      OTP_HMAC_SECRET: 'test-only-not-a-secret-pg-eos-identity-suite',
    },
  },
});
