// tests/scenarios/migration-0047.spec.ts — RED test for migration 0047 (WBS 2.9 part 3 step 2, D-211).
//
// Migration 0047_1_quarantine-decision-chain-threshold.sql is data only: it seeds
//   platform.approval_chains ('quarantine_decision', step 1, 'SALES_MGR', active) and
//   platform.thresholds 'wms.quarantine.decision_due_hours' = 48 (doc 40 line 438, D-211),
// both `on conflict do nothing`. This spec applies the file (idempotent seed) and checks the rows,
// then re-applies it and checks nothing changed. It seeds nothing itself and deletes nothing.
//
// Matched by playwright.config.ts testMatch (/migration-\d{4}\.spec\.ts$/); gates nothing in CI ④ / G15.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { Pool } from 'pg';

import { createPool } from './fixtures/pool.js';

const MIGRATION_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'database',
  'migrations',
  '0047_1_quarantine-decision-chain-threshold.sql',
);
const REQUEST_TYPE = 'quarantine_decision';
const EXPECTED_ROLE = 'SALES_MGR';
const DUE_HOURS_KEY = 'wms.quarantine.decision_due_hours';
const EXPECTED_DUE_HOURS = 48; // doc 40 line 438 / D-211
const SYSTEM_SEED_CHANGED_BY = '00000000-0000-0000-0000-000000000000';

interface ChainRow {
  step_no: number;
  approver_role: string;
  is_active: boolean;
}
interface ThresholdRow {
  value: string;
  changed_by: string;
}

test.describe('migration 0047 — quarantine decision chain row and due-hours threshold seed', () => {
  let pool: Pool;
  let sqlText: string;
  test.beforeAll(() => {
    pool = createPool();
    sqlText = readFileSync(MIGRATION_FILE, 'utf8');
  });
  test.afterAll(async () => {
    await pool.end();
  });

  async function chainRows(): Promise<ChainRow[]> {
    const { rows } = await pool.query<ChainRow>(
      'select step_no, approver_role, is_active from platform.approval_chains where request_type = $1',
      [REQUEST_TYPE],
    );
    return rows;
  }
  async function thresholdRows(): Promise<ThresholdRow[]> {
    const { rows } = await pool.query<ThresholdRow>(
      'select value::text as value, changed_by::text as changed_by from platform.thresholds where key = $1',
      [DUE_HOURS_KEY],
    );
    return rows;
  }

  test('after applying the file: one active step-1 SALES_MGR chain row and one due-hours threshold = 48', async () => {
    await pool.query(sqlText);
    const chain = await chainRows();
    expect(chain).toHaveLength(1);
    expect(chain[0]).toEqual({ step_no: 1, approver_role: EXPECTED_ROLE, is_active: true });
    const thresholds = await thresholdRows();
    expect(thresholds).toHaveLength(1);
    expect(Number(thresholds[0]?.value)).toBe(EXPECTED_DUE_HOURS);
    expect(thresholds[0]?.changed_by).toBe(SYSTEM_SEED_CHANGED_BY);
  });

  test('re-applying the file changes nothing (same rows, same values)', async () => {
    const chainBefore = await chainRows();
    const thresholdsBefore = await thresholdRows();
    await pool.query(sqlText);
    expect(await chainRows()).toEqual(chainBefore);
    expect(await thresholdRows()).toEqual(thresholdsBefore);
  });
});
