// tests/scenarios/migration-0045.spec.ts — RED test for migration 0045 (X part 5d part 2 item 2).
//
// Migration 0045 seeds platform.thresholds 'identity.session.lifetime_minutes' = 720 minutes
// (GM value D-203, verbatim «١٢» hours), same form as 0042 (`on conflict (key) do nothing`,
// changed_by = the all-zero system user). This spec only READS; it never seeds or deletes the row.
//
// Matched by playwright.config.ts testMatch (/migration-\d{4}\.spec\.ts$/). scenarios-verdict
// ignores non-S specs, so this file gates nothing in CI ④ / G15; it is a manual / seed check.
// Run: `playwright test migration-0045.spec.ts`.
import { SESSION_LIFETIME_MINUTES_KEY } from '@pg-eos/identity-mechanisms';
import { expect, test } from '@playwright/test';
import type { Pool } from 'pg';
import { createPool } from './fixtures/pool.js';

const EXPECTED_LIFETIME_MINUTES = 720; // D-203: 12 hours
const EXPECTED_UNIT = 'minutes';
const SYSTEM_SEED_CHANGED_BY = '00000000-0000-0000-0000-000000000000';

interface ThresholdRow {
  value: string;
  unit: string;
  changed_by: string;
}

test.describe('migration 0045 — session lifetime threshold seed', () => {
  let pool: Pool;
  test.beforeAll(() => {
    pool = createPool();
  });
  test.afterAll(async () => {
    await pool.end();
  });

  test('platform.thresholds holds exactly one identity.session.lifetime_minutes row = 720 minutes by the system user', async () => {
    const { rows } = await pool.query<ThresholdRow>(
      'select value::text as value, unit, changed_by::text as changed_by from platform.thresholds where key = $1',
      [SESSION_LIFETIME_MINUTES_KEY],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error('unreachable: length asserted above');
    expect(Number(row.value)).toBe(EXPECTED_LIFETIME_MINUTES);
    expect(row.unit).toBe(EXPECTED_UNIT);
    expect(row.changed_by).toBe(SYSTEM_SEED_CHANGED_BY);
  });
});
