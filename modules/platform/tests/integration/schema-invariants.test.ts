// WBS 0.9 (pg-tester). `platform` schema — atomic doc numbering and the audit hash chain are
// ALREADY DELIVERED in database/schema/01-Data-Model.sql and 13B-Schema-Reference-Consolidation.sql
// (frozen files; see .claude/briefs/platform.brief.md and doc 40 §B2/§B3 — "nothing here is
// created by a slice"). There is no application code to build for this task: this file is the
// permanent, re-runnable proof that the two WBS 0.9 acceptance numbers hold against a live
// Postgres instance — genuine connection-pool concurrency for `platform.next_doc_no`, and a
// genuine tamper for `platform.verify_audit_chain`. There is no RED phase — both assertions are
// expected to pass immediately against the schema as delivered.
//
// Connects to the already-running dev database (infra/docker/docker-compose.yml, `postgres`
// service) via PG* env vars, defaulting to the documented local values.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

// Resolved in beforeAll from the live `platform.entities` seed — never hardcoded, per brief.
let pccEntityId: string;

beforeAll(async () => {
  const result: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PCC'],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      "seed entity 'PCC' not found in platform.entities — is database/schema/apply.sh applied to this database?",
    );
  }
  pccEntityId = row.id;
});

afterAll(async () => {
  await pool.end();
});

describe('platform.next_doc_no — atomic allocator under concurrency (WBS 0.9 acceptance #1)', () => {
  it('100 concurrent calls against the PCC/DOC/ALL counter return 100 unique, correctly formatted numbers', async () => {
    // Genuine parallelism through the pool: all 100 queries are fired here, before any of them
    // is awaited, and the pool (max: 20) interleaves them across its connections. This is NOT a
    // client-side loop that awaits each call in turn.
    const calls: Array<Promise<QueryResult<{ next_doc_no: string }>>> = Array.from(
      { length: 100 },
      () => pool.query(`select platform.next_doc_no($1, $2, $3)`, [pccEntityId, 'DOC', 'ALL']),
    );

    const results = await Promise.all(calls);
    const docNumbers = results.map((result) => {
      const row = result.rows[0];
      if (!row) {
        throw new Error('platform.next_doc_no() returned no row for one of the 100 calls');
      }
      return row.next_doc_no;
    });

    // Distinctness is the acceptance criterion itself. The counter is a shared, persistent
    // sequence (seeded at current_val = 0, prefix PCC-DC-, padding 5) that keeps incrementing
    // across test runs — that is correct atomic-sequence behavior, so the exact numeric range is
    // never asserted here, only distinctness and format.
    expect(docNumbers).toHaveLength(100);
    expect(new Set(docNumbers).size).toBe(100);

    const docNoFormat = /^PCC-DC-\d{5}$/;
    for (const docNo of docNumbers) {
      expect(docNo).toMatch(docNoFormat);
    }
  });
});

describe('platform.verify_audit_chain — hash-chain correctness and tamper detection (WBS 0.9 acceptance #2)', () => {
  it('verifies a freshly inserted chain clean, then flags a deliberately tampered row', async () => {
    // platform.audit_log is append-only (REVOKE UPDATE, DELETE from the application role) and
    // starts empty on this database. Every row below is inserted through the real
    // platform.audit_hash_chain() BEFORE INSERT trigger — prev_hash/row_hash are never set by
    // this test, only read back afterwards.
    const fixtureRecordIds = Array.from({ length: 4 }, () => randomUUID());
    const fixtureRows: Array<{ id: string; occurredAt: Date }> = [];

    // occurred_at is supplied explicitly, advancing by 2ms per row, so insertion order is
    // unambiguous regardless of how fast the round-trips to the database happen to run.
    const baseOccurredAt = Date.now();

    for (const [index, recordId] of fixtureRecordIds.entries()) {
      const occurredAt = new Date(baseOccurredAt + index * 2);
      const insertResult: QueryResult<{ id: string; occurred_at: Date }> = await pool.query(
        `insert into platform.audit_log
           (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation)
         values ($1, null, 'system', $2, 'platform', '_test_fixture', $3, 'insert')
         returning id, occurred_at`,
        [occurredAt, pccEntityId, recordId],
      );
      const row = insertResult.rows[0];
      if (!row) {
        throw new Error('insert into platform.audit_log returned no row');
      }
      fixtureRows.push({ id: row.id, occurredAt: row.occurred_at });
    }

    // Whole-table, matching the WBS 0.9 acceptance wording verbatim: "platform.verify_audit_chain()
    // returns zero rows". This is only safe because the tamper below is always reverted before this
    // test ends (see the restore after the tampered-check assertion) — the table is left exactly as
    // it was found, so a fresh run never inherits scar tissue from a previous one.
    const cleanCheck: QueryResult<{ id: string }> = await pool.query(
      'select * from platform.verify_audit_chain()',
    );
    expect(cleanCheck.rows).toEqual([]);

    const target = fixtureRows[0];
    if (!target) {
      throw new Error('no fixture row available to tamper with');
    }

    // Capture the original (correct) row_hash BEFORE tampering, so it can be restored afterwards —
    // this is what makes the whole-table assertion above safe to re-run.
    const originalHashResult: QueryResult<{ row_hash: string }> = await pool.query(
      `select row_hash from platform.audit_log where id = $1 and occurred_at = $2`,
      [target.id, target.occurredAt],
    );
    const originalRow = originalHashResult.rows[0];
    if (!originalRow) {
      throw new Error('could not read back original row_hash for the fixture row to tamper with');
    }
    const originalRowHash = originalRow.row_hash;

    // The tamper, detection assertion, and restore are wrapped in try/finally so the restore is
    // ALWAYS attempted — whether the detection assertion below passes, throws (the exact scenario
    // where platform.verify_audit_chain() has regressed and no longer flags the tampered row — the
    // one case this test exists to catch), or any query in between rejects. Without this, a failed
    // assertion would skip the restore and leave the row permanently tampered, red-lining the
    // deployment-blocking G8 guard until a manual `apply.sh --recreate`.
    try {
      // Connected as the postgres table owner, so this UPDATE bypasses the REVOKE that applies to
      // the application role (confirmed live via \dp platform.audit_log).
      await pool.query(
        `update platform.audit_log set row_hash = 'deliberately-tampered-hash' where id = $1 and occurred_at = $2`,
        [target.id, target.occurredAt],
      );

      const tamperedCheck: QueryResult<{ id: string }> = await pool.query(
        'select * from platform.verify_audit_chain()',
      );
      const flaggedIds = tamperedCheck.rows.map((row) => row.id);

      // The function may also flag the row chained immediately after the tampered one — that is
      // correct chain-forensics behavior, so this asserts membership, not an exact row count.
      expect(flaggedIds).toContain(target.id);
    } finally {
      // Restore the original row_hash no matter what happened above, so this test proves
      // tamper-detection without permanently corrupting the audit chain it is protecting (WBS 0.9 —
      // platform.audit_log participates in deployment-blocking guard G8).
      await pool.query(
        `update platform.audit_log set row_hash = $3 where id = $1 and occurred_at = $2`,
        [target.id, target.occurredAt, originalRowHash],
      );
    }

    // Nice-to-have: confirm the restore actually took — the fixture row is no longer flagged.
    const restoredCheck: QueryResult<{ id: string }> = await pool.query(
      'select * from platform.verify_audit_chain()',
    );
    expect(restoredCheck.rows.some((row) => row.id === target.id)).toBe(false);
  });
});
