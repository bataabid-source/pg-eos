import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
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
    // WBS 2.8 close-out: the suites share one database, grant/revoke on the same tables (catalog
    // row contention: "tuple concurrently updated") and the global audit-chain lock (ADR-0002) — files
    // run one after another, as in modules/platform.
    fileParallelism: false,
  },
});
