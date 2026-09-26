import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts', 'tests/otp-login/**/*.test.ts'],
    environment: 'node',
    // Same fixed, self-describing test value as packages/identity/vitest.config.ts: the WBS 0.17
    // mechanism (@pg-eos/identity-mechanisms) keys its OTP/session hashes with OTP_HMAC_SECRET and
    // has no default. Set here (not in a beforeAll) so it is in place before any import resolves.
    env: {
      OTP_HMAC_SECRET: 'test-only-not-a-secret-pg-eos-identity-suite',
    },
  },
});
