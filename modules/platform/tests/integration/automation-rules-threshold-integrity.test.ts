// WBS 0.10 (pg-tester). `platform.automation_rules` and `platform.thresholds` are ALREADY
// DELIVERED in database/schema/13B-Schema-Reference-Consolidation.sql (frozen file; see
// .claude/briefs/platform.brief.md). This file is a permanent, re-runnable regression test for the
// invariant documented by the inline column comment at
// database/schema/13B-Schema-Reference-Consolidation.sql:321 (`threshold_key text, -- a key in
// platform.thresholds`): `automation_rules.threshold_key` is a documented convention pointing at
// `platform.thresholds.key`, NOT a database foreign key — so a typo'd key would silently break
// automation with no error anywhere else in the system.
//
// The first `it` is a read-only check against real seed data. The second `it` is a negative
// control: it inserts one throwaway row with a deliberately bogus threshold_key, proves the same
// integrity query flags it, then deletes it in a `finally` — this is what makes the first `it`
// meaningful (proof the query can actually fail, not just proof it currently returns zero rows).
//
// Connects to the already-running dev database via PG* env vars, defaulting to the documented
// local values — same convention as schema-invariants.test.ts (WBS 0.9).

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

afterAll(async () => {
  await pool.end();
});

const INTEGRITY_QUERY = `
  select ar.code, ar.threshold_key
  from platform.automation_rules ar
  where ar.threshold_key is not null
    and not exists (select 1 from platform.thresholds t where t.key = ar.threshold_key)
`;

// A code/threshold_key pair used only by the negative-control test below; never left behind.
const BOGUS_RULE_CODE = 'wbs-0.10-negative-control-bogus-rule';
const BOGUS_THRESHOLD_KEY = 'wbs-0.10-negative-control-key-that-does-not-exist';

describe('platform.automation_rules.threshold_key — referential integrity against platform.thresholds (13B:321)', () => {
  it('every non-null threshold_key names a key that actually exists in platform.thresholds', async () => {
    const result: QueryResult<{ code: string; threshold_key: string }> = await pool.query(INTEGRITY_QUERY);

    if (result.rows.length > 0) {
      const offending = result.rows
        .map((row) => `(code=${row.code}, threshold_key=${row.threshold_key})`)
        .join(', ');
      throw new Error(
        `${result.rows.length} platform.automation_rules row(s) reference a threshold_key that ` +
          `does not exist in platform.thresholds — this is not DB-enforced by a foreign key, so it ` +
          `fails silently everywhere else in the system: ${offending}`,
      );
    }

    expect(result.rows).toEqual([]);
  });

  it('negative control: the integrity query DOES flag a row with a bogus threshold_key', async () => {
    // Guard against a key that happens to collide with real seed/GM data — this must never match.
    const collision = await pool.query(`select 1 from platform.thresholds where key = $1`, [
      BOGUS_THRESHOLD_KEY,
    ]);
    expect(collision.rows).toEqual([]);

    try {
      await pool.query(
        `insert into platform.automation_rules (code, process, level, owner_role, threshold_key)
         values ($1, 'wbs-0.10-negative-control', 'A0', 'system', $2)`,
        [BOGUS_RULE_CODE, BOGUS_THRESHOLD_KEY],
      );

      const result: QueryResult<{ code: string; threshold_key: string }> = await pool.query(
        INTEGRITY_QUERY,
      );

      expect(result.rows).toEqual([{ code: BOGUS_RULE_CODE, threshold_key: BOGUS_THRESHOLD_KEY }]);
    } finally {
      // Nothing this test inserts may survive it, whether the assertion above passed or threw.
      await pool.query(`delete from platform.automation_rules where code = $1`, [BOGUS_RULE_CODE]);
    }

    // Confirm cleanup actually took — the throwaway row must be gone.
    const postCleanup = await pool.query(`select 1 from platform.automation_rules where code = $1`, [
      BOGUS_RULE_CODE,
    ]);
    expect(postCleanup.rows).toEqual([]);
  });
});
