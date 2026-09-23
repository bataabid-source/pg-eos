// tests/ops/vitest.config.ts — WBS 0.8 (pg-tester).
//
// Mirrors tests/isolation/vitest.config.ts's conventions. `testTimeout` is generous here for a
// different reason than isolation's: backup-restore.test.ts shells out to `pg_dump`/`pg_restore`
// (via scripts/backup.sh / scripts/restore.sh) against a real, seeded pgeos database
// (191 tables incl. partitions, docs/notes/2026-09-23-restore-rehearsal.md) — a full dump/restore
// round trip took several seconds even in the manual rehearsal, and CI/dev machines vary.
// `fileParallelism: false` for the same reason as isolation: there is one spec file today, and the
// target database name `pgeos_restore` is a single fixed name (not a per-run random suffix), so a
// second file added later must not race it.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
