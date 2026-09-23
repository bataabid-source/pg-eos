import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    // GM directive 2026-09-23 (SCR-AUDIT-01, condition 5): the audit-chain suites share one table and
    // one whole-table G8 check — files run one after another, never in parallel.
    fileParallelism: false,
  },
});
