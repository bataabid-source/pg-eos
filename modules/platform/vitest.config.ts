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
    // WBS 5.13: include widened from tests/integration to tests/** so the golden-slice-shaped
    // tests/evaluate-alerts/ suite runs here too (same as modules/wms after 2.9).
    // GM directive 2026-09-23 (SCR-AUDIT-01, condition 5): the audit-chain suites share one table and
    // one whole-table G8 check — files run one after another, never in parallel.
    fileParallelism: false,
  },
});
