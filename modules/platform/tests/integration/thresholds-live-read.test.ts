// WBS 0.10 (pg-tester). `platform.thresholds` is ALREADY DELIVERED in
// database/schema/13B-Schema-Reference-Consolidation.sql (frozen file; see
// .claude/briefs/platform.brief.md and doc 40 §B5 — "nothing here is created by a slice"). There
// is no application code to build for this task: this file is the permanent, re-runnable proof of
// the doc-38 acceptance criterion for WBS 0.10 — "Threshold change takes effect without redeploy" —
// against a live Postgres instance. There is no RED phase — the assertion is expected to pass
// immediately against the schema and seed data as delivered.
//
// Connects to the already-running dev database (infra/docker/docker-compose.yml, `postgres`
// service) via PG* env vars, defaulting to the documented local values — same convention as
// schema-invariants.test.ts (WBS 0.9).

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

// A real seeded ADR-27 key (13B ~line 1323-1339), not invented — value/unit confirmed live below,
// never hardcoded into an assertion (only usable as a restore fallback if the initial read fails).
const THRESHOLD_KEY = 'dtl.auto_close.max_cod_kwd';

// Per the brief: platform.thresholds.changed_by is NOT NULL; seed data and this test share the
// same sentinel actor id.
const SENTINEL_CHANGED_BY = '00000000-0000-0000-0000-000000000000';

afterAll(async () => {
  await pool.end();
});

describe('platform.thresholds — live read, no redeploy required (WBS 0.10 acceptance)', () => {
  it('a value changed on one physical connection is visible to an independent read on a distinct physical connection, with no delay and no cache layer between writer and reader', async () => {
    // Step 1 — read the real, currently-seeded row. Never hardcoded: this is what makes the
    // "clearly different" new value below always distinct, whatever a prior run or GM edit left
    // behind. changed_by/changed_at are captured too, because the mutation below overwrites them
    // and both must be restored exactly — this test may not permanently destroy real provenance.
    const initialRead: QueryResult<{
      value: string;
      unit: string | null;
      changed_by: string;
      changed_at: string;
    }> = await pool.query(
      `select value, unit, changed_by, changed_at from platform.thresholds where key = $1`,
      [THRESHOLD_KEY],
    );
    const initialRow = initialRead.rows[0];
    if (!initialRow) {
      throw new Error(
        `seed threshold '${THRESHOLD_KEY}' not found in platform.thresholds — is database/schema/apply.sh applied to this database?`,
      );
    }
    const originalValue = initialRow.value;
    const originalUnit = initialRow.unit;
    const originalChangedBy = initialRow.changed_by;
    const originalChangedAt = initialRow.changed_at;

    // Step 2 — baseline sanity: a second, independent query for the same key returns the exact
    // same value before anything is mutated (proving this is the real row, not a cached test
    // double, and that reads are stable prior to the change under test).
    const baselineCheck: QueryResult<{ value: string }> = await pool.query(
      `select value from platform.thresholds where key = $1`,
      [THRESHOLD_KEY],
    );
    const baselineRow = baselineCheck.rows[0];
    if (!baselineRow) {
      throw new Error(`baseline re-read of '${THRESHOLD_KEY}' returned no row`);
    }
    expect(baselineRow.value).toBe(originalValue);

    // A value "clearly different" from the original, still numeric(14,3)-valid — derived from the
    // real captured value, never an invented absolute number.
    const newValue = (Number(originalValue) + 1).toFixed(3);
    expect(newValue).not.toBe(originalValue);

    // Two EXPLICIT, distinct clients checked out of the pool. Neither is released back to the pool
    // until the other is also done with it, which forces pg.Pool to hand out two separate physical
    // connections (a sequential await pool.query()/await pool.query() pair would just reuse the one
    // idle connection it created, proving nothing about connection-pinned staleness). writer performs
    // the mutation; reader performs the read-back — genuinely independent physical connections, not
    // just independent query calls.
    const writer = await pool.connect();
    const reader = await pool.connect();

    // The mutation and the reverting restore are wrapped in try/finally so the restore is ALWAYS
    // attempted — whether the read-back assertion below passes, throws (the exact scenario where
    // a cache/materialized view has regressed the "no redeploy" property this test exists to
    // catch), or any query in between rejects. Without this, a failed assertion would leave the
    // threshold permanently changed in the live database — the same class of mistake WBS 0.9's
    // review caught twice (an un-reverted tamper, and a non-exception-safe restore).
    try {
      // The write happens on `writer`.
      await writer.query(
        `update platform.thresholds set value = $2, changed_by = $3, changed_at = now() where key = $1`,
        [THRESHOLD_KEY, newValue, SENTINEL_CHANGED_BY],
      );

      // The read-back happens on `reader` — a distinct physical connection from `writer`. This IS
      // the "without redeploy" proof: an ordinary committed read on a different connection sees the
      // change immediately, with no polling and no delay, exactly like any other row in the table.
      // If there were a cache, a materialized view, or connection-pinned staleness standing between
      // "the GM edits a number" and "the next read (on any connection) sees it", this assertion
      // would fail.
      const readBack: QueryResult<{ value: string }> = await reader.query(
        `select value from platform.thresholds where key = $1`,
        [THRESHOLD_KEY],
      );
      const readBackRow = readBack.rows[0];
      if (!readBackRow) {
        throw new Error(`read-back of '${THRESHOLD_KEY}' after update returned no row`);
      }
      expect(readBackRow.value).toBe(newValue);
    } finally {
      // Restore the original value AND the original provenance (changed_by, changed_at) no matter
      // what happened above, so this test proves live-read behavior without permanently corrupting
      // an operational threshold — or its audit trail — that automation rules may depend on (see
      // automation-rules-threshold-integrity.test.ts).
      await writer.query(
        `update platform.thresholds set value = $2, changed_by = $3, changed_at = $4 where key = $1`,
        [THRESHOLD_KEY, originalValue, originalChangedBy, originalChangedAt],
      );
      writer.release();
      reader.release();
    }

    // Confirm the restore actually took, on all four columns this test mutated — mirrors
    // schema-invariants.test.ts's restore-then-verify pattern exactly.
    const restoredCheck: QueryResult<{
      value: string;
      unit: string | null;
      changed_by: string;
      changed_at: string;
    }> = await pool.query(
      `select value, unit, changed_by, changed_at from platform.thresholds where key = $1`,
      [THRESHOLD_KEY],
    );
    const restoredRow = restoredCheck.rows[0];
    if (!restoredRow) {
      throw new Error(`post-restore read of '${THRESHOLD_KEY}' returned no row`);
    }
    expect(restoredRow.value).toBe(originalValue);
    expect(restoredRow.unit).toBe(originalUnit);
    expect(restoredRow.changed_by).toBe(originalChangedBy);
    expect(new Date(restoredRow.changed_at).getTime()).toBe(new Date(originalChangedAt).getTime());
  });
});
