import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // WBS 2.8 close-out: the suites share one database, grant/revoke on the same tables (catalog
    // row contention: "tuple concurrently updated") and the global audit-chain lock (ADR-0002) — files
    // run one after another, as in modules/platform.
    fileParallelism: false,
  },
});
