import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // WBS 1.5 proof slice (ADR-0001): the suite shares one database and asserts against shared
    // catalog objects (sales.accounts, sales.possible_duplicates) — files run one after another,
    // as in modules/wms (2.8 close-out).
    fileParallelism: false,
  },
});
