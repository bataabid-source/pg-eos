// WBS 0.9 (pg-tester) — SCR-AUDIT-01 regression, GM directive 2026-09-23 item G4.
// Scenario: ./audit-chain-concurrency.feature. Defect: docs/notes/SCR-AUDIT-01-hash-chain-order-race.md.
//
// platform.audit_hash_chain() (13B-2) chains each new row to the previous row selected AFTER the
// advisory lock, i.e. in lock-acquisition order; platform.verify_audit_chain() recomputes the chain
// in (occurred_at, id) order. Under concurrent writers the two orders disagree and G8 goes red.
// schema-invariants.test.ts proves tamper detection with sequential inserts only; this file is the
// concurrent counterpart.
//
// Design-agnostic by construction: it asserts only on columns and functions that exist in 13B today
// (record_id, table_name, platform.verify_audit_chain()) — never on a future ordering column — so it
// stays valid whichever fix the GM picks for SCR-AUDIT-01.
//
// Audit rows are NEVER deleted by this test: platform.audit_log is an append-only hash chain
// (REVOKE UPDATE, DELETE; doc 31 §4) and WBS 0.18 set the tail-only precedent — a fixture may only
// append. Every run therefore leaves its 4,000 rows behind; a clean database is obtained with
// `bash database/schema/apply.sh --recreate`, never by editing audit rows.
//
// Connects to the already-running dev database via PG* env vars, same style as
// schema-invariants.test.ts.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { PoolClient, QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Source: GM directive 2026-09-23 G4: ≥ 8 × 500.
const WRITERS = 8;
// Source: GM directive 2026-09-23 G4: ≥ 8 × 500.
const INSERTS_PER_WRITER = 500;
// Half the writers use the column default now(); the other half share one fixed timestamp — the
// tie case the SCR-AUDIT-01 note (§1) names as the one that most reliably exposes the race.
const DEFAULT_NOW_WRITERS = WRITERS / 2;
// 4,000 inserts, each serialised behind the trigger's advisory lock, each its own transaction:
// a few seconds of real DB work on the dev container; 120 s leaves ample headroom for a slow
// Windows/Docker host without letting a genuine hang go unnoticed.
const TEST_TIMEOUT_MS = 120_000;
// Fixture table_name — scopes this run's rows; not a real table (same convention as '_test_fixture'
// in schema-invariants.test.ts).
const FIXTURE_TABLE_NAME = '_audit_concurrency_fixture';

// One connection per writer, plus one for the control queries (precondition, counts, verifier).
const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: WRITERS + 1,
});

// Resolved in beforeAll from the live `platform.entities` seed — never hardcoded.
let pccEntityId: string;
// Fixed timestamp for the tie writers: start of the current month, read once from the DB as text so
// it lands in the current month's partition and is passed back byte-identical (no JS Date round-trip).
let fixedOccurredAt: string;

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PCC'],
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) {
    throw new Error(
      "seed entity 'PCC' not found in platform.entities — is database/schema/apply.sh applied to this database?",
    );
  }
  pccEntityId = entityRow.id;

  const monthResult: QueryResult<{ month_start: string }> = await pool.query(
    `select date_trunc('month', now())::text as month_start`,
  );
  const monthRow = monthResult.rows[0];
  if (!monthRow) {
    throw new Error("select date_trunc('month', now()) returned no row");
  }
  fixedOccurredAt = monthRow.month_start;
});

afterAll(async () => {
  await pool.end();
});

async function countBrokenChainRows(): Promise<number> {
  const result: QueryResult<{ broken: string }> = await pool.query(
    'select count(*)::text as broken from platform.verify_audit_chain()',
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('select count(*) from platform.verify_audit_chain() returned no row');
  }
  return Number(row.broken);
}

/** One writer: INSERTS_PER_WRITER inserts on its own connection, each in its own transaction. */
async function runWriter(
  client: PoolClient,
  useFixedOccurredAt: boolean,
  recordIds: readonly string[],
): Promise<void> {
  for (const recordId of recordIds) {
    await client.query('begin');
    try {
      if (useFixedOccurredAt) {
        await client.query(
          `insert into platform.audit_log
             (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation)
           values ($1::timestamptz, null, 'system', $2, 'platform', $3, $4, 'insert')`,
          [fixedOccurredAt, pccEntityId, FIXTURE_TABLE_NAME, recordId],
        );
      } else {
        // occurred_at omitted — the column default now() applies.
        await client.query(
          `insert into platform.audit_log
             (user_id, actor_type, entity_id, schema_name, table_name, record_id, operation)
           values (null, 'system', $1, 'platform', $2, $3, 'insert')`,
          [pccEntityId, FIXTURE_TABLE_NAME, recordId],
        );
      }
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    }
  }
}

describe("platform.audit_log's hash chain stays valid under concurrent writers (SCR-AUDIT-01 regression, WBS 0.9)", () => {
  it(
    `${WRITERS} concurrent writers x ${INSERTS_PER_WRITER} single-row transactions leave platform.verify_audit_chain() at zero rows`,
    async () => {
      // Precondition — the chain must be clean before the run, otherwise a red result would not be
      // attributable to this run. The test never repairs data.
      const brokenBefore = await countBrokenChainRows();
      expect(
        brokenBefore,
        `platform.verify_audit_chain() already returns ${brokenBefore} broken rows BEFORE the run — ` +
          'start from a clean database: bash database/schema/apply.sh --recreate',
      ).toBe(0);

      // Every row of this run is identified by its record_id (the run's own set of random uuids).
      const recordIdsPerWriter: string[][] = Array.from({ length: WRITERS }, () =>
        Array.from({ length: INSERTS_PER_WRITER }, () => randomUUID()),
      );
      const runRecordIds = recordIdsPerWriter.flat();

      // Check out one dedicated connection per writer BEFORE starting any of them, so the 8 loops
      // are guaranteed to be on 8 distinct backends and genuinely overlap.
      const clients: PoolClient[] = [];
      for (let index = 0; index < WRITERS; index += 1) {
        clients.push(await pool.connect());
      }

      try {
        await Promise.all(
          clients.map((client, writerIndex) =>
            runWriter(
              client,
              writerIndex >= DEFAULT_NOW_WRITERS,
              recordIdsPerWriter[writerIndex] ?? [],
            ),
          ),
        );
      } finally {
        for (const client of clients) {
          client.release();
        }
      }

      const insertedResult: QueryResult<{ inserted: string }> = await pool.query(
        `select count(*)::text as inserted
           from platform.audit_log
          where table_name = $1
            and record_id = any($2::uuid[])`,
        [FIXTURE_TABLE_NAME, runRecordIds],
      );
      const insertedRow = insertedResult.rows[0];
      if (!insertedRow) {
        throw new Error("count of this run's audit rows returned no row");
      }
      expect(Number(insertedRow.inserted)).toBe(WRITERS * INSERTS_PER_WRITER);

      const brokenAfter = await countBrokenChainRows();
      expect(
        brokenAfter,
        `platform.verify_audit_chain() returned ${brokenAfter} broken rows after ` +
          `${WRITERS} x ${INSERTS_PER_WRITER} concurrent audit inserts (SCR-AUDIT-01)`,
      ).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
