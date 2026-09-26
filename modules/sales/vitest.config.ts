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
    // WBS 1.5 proof slice (ADR-0001): the suite shares one database and asserts against shared
    // catalog objects (sales.accounts, sales.possible_duplicates) — files run one after another,
    // as in modules/wms (2.8 close-out).
    fileParallelism: false,
  },
});
