// WBS 0.9 (pg-tester) — SCR-AUDIT-01 approved fix, GM decision 2026-09-23 (#4), phase G.
// Scenario: ./audit-chain-seq.feature. Interface under test (fixed): docs/notes/
// SCR-AUDIT-01-hash-chain-order-race.md §7.1 —
//   * column platform.audit_log.chain_seq bigint not null, assigned by platform.audit_hash_chain()
//     as previous chain_seq + 1 under the advisory lock (gapless; a rolled-back row releases its number);
//   * unique index `<partition>_chain_seq_key` on (chain_seq) on EVERY partition, default included
//     (GM condition 1) — checked by pg_index properties only, never by index name (finding 9);
//   * audited writes refused unless the transaction runs under READ COMMITTED, and row_hash
//     rendering independent of the session timezone/datestyle (pg-reviewer migration gate);
//   * platform.verify_audit_chain(p_anchor_seq bigint default 1, p_anchor_prev_hash text default null)
//     returning (chain_seq, id, occurred_at, problem, detail, expected_hash, actual_hash), problem ∈
//     hash_mismatch · prev_hash_mismatch · duplicate_chain_seq · chain_seq_gap ·
//     partition_missing_chain_seq_unique_index (GM condition 3: the anchor).
//
// Nothing persists: every scenario that writes runs inside ONE transaction on one dedicated client,
// rolled back in `finally`. platform.audit_log is append-only for the application role; the deletes
// and updates below run as the postgres table owner and are always rolled back, so the whole-table
// G8 check (last describe block) sees the table exactly as it was found.
//
// Each transaction first takes the trigger's own advisory lock (§7.1: hashtext('platform.audit_log')),
// so no other writer can append between the head read and this scenario's inserts — the expected
// chain_seq values are then derived only from the head read in the same transaction, never invented.
//
// Connects to the already-running dev database via PG* env vars, same style as
// schema-invariants.test.ts.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { PoolClient, QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Fixture table_name — scopes this file's rows; not a real table (same convention as
// '_test_fixture' in schema-invariants.test.ts). Source: GM directive 2026-09-23 phase G.
const FIXTURE_TABLE_NAME = '_audit_chain_seq_fixture';
// Advisory-lock key taken by platform.audit_hash_chain() (SCR-AUDIT-01 §7.1).
const AUDIT_CHAIN_LOCK_KEY = 'platform.audit_log';
// The audit table and its default partition (13B-2).
const AUDIT_LOG_TABLE = 'platform.audit_log';
const DEFAULT_PARTITION = 'platform.audit_log_default';
// Indexed column (SCR-AUDIT-01 §7.1).
const CHAIN_SEQ_COLUMN = 'chain_seq';
// Negative control (GM directive phase G item a): a far-future month created WITHOUT the index.
const NEGATIVE_CONTROL_PARTITION = 'audit_log_2099_01';
const NEGATIVE_CONTROL_FROM = '2099-01-01 00:00:00+00';
const NEGATIVE_CONTROL_TO = '2099-02-01 00:00:00+00';
// A timestamp far outside every range partition, so the row lands in audit_log_default
// (GM directive phase G item e).
const DEFAULT_PARTITION_OCCURRED_AT = '2030-01-01 00:00:00+00';
// Deliberate tamper values — never valid sha256 hex, so they can never collide with a real hash.
const TAMPERED_ROW_HASH = 'deliberately-tampered-hash';
const WRONG_ANCHOR_PREV_HASH = 'deliberately-wrong-anchor-prev-hash';
// Scenario sizes (GM directive phase G items b, d, g).
const NUMBERING_ROWS = 3;
const GAP_ROWS = 3;
const ANCHOR_ROWS = 4;
// Item g: anchorSeq = s + 2, i.e. the third of the four rows (zero-based index 2).
const ANCHOR_ROW_INDEX = 2;
// Isolation refusal (pg-reviewer migration gate): the trigger raises
// 'platform.audit_hash_chain: audited writes must run under READ COMMITTED (current: repeatable read)'.
// The requirement pinned here is the phrase; matched case-insensitively.
const READ_COMMITTED_PHRASE = /read committed/i;
// Rendering pin (pg-reviewer migration gate): the row is written under one session zone/datestyle
// and verified under a different one. Both zones are real IANA names with different UTC offsets.
const WRITE_TIMEZONE = 'Asia/Kolkata';
const VERIFY_TIMEZONE = 'America/New_York';
const WRITE_DATESTYLE = 'SQL, DMY';
const VERIFY_DATESTYLE = 'ISO, MDY';

// problem codes (SCR-AUDIT-01 §7.1; anchorInvalid / anchorNotFound added by pg-reviewer round 2).
const PROBLEM = {
  hashMismatch: 'hash_mismatch',
  prevHashMismatch: 'prev_hash_mismatch',
  duplicateChainSeq: 'duplicate_chain_seq',
  chainSeqGap: 'chain_seq_gap',
  partitionMissingIndex: 'partition_missing_chain_seq_unique_index',
  anchorInvalid: 'anchor_invalid',
  anchorNotFound: 'anchor_not_found',
} as const;
// Temporary roles (pg-reviewer round 2). Prefix fixed by the Master; `pg_` is reserved by
// PostgreSQL and is never used. Every role is created inside a rolled-back transaction, so none
// persists (CREATE ROLE is transactional).
const TEMP_ROLE_PREFIX = 'pgeos_t_';
// SQLSTATE insufficient_privilege (PostgreSQL errcodes, class 42).
const SQLSTATE_INSUFFICIENT_PRIVILEGE = '42501';
// The verifier's name as it appears in PostgreSQL's "permission denied for function …" message.
const VERIFIER_FUNCTION_NAME = 'verify_audit_chain';
// pg-reviewer round 2 item 4: an anchor "max chain_seq + 10", i.e. strictly above the head.
const ANCHOR_ABOVE_HEAD_OFFSET = 10n;

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 2,
});

// Resolved in beforeAll from the live `platform.entities` seed — never hardcoded.
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

interface FixtureRow {
  id: string;
  occurredAt: string;
  chainSeq: bigint;
  prevHash: string | null;
  rowHash: string;
  partition: string;
}

interface ChainProblem {
  chainSeq: bigint | null;
  id: string | null;
  occurredAt: string | null;
  problem: string;
  detail: string | null;
  expectedHash: string | null;
  actualHash: string | null;
}

/**
 * Runs `fn` inside one transaction on a dedicated client and ALWAYS rolls back. The trigger's
 * advisory lock is taken first so no other writer can append while the scenario runs.
 */
async function inRolledBackTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [AUDIT_CHAIN_LOCK_KEY]);
    await fn(client);
  } finally {
    let rollbackError: Error | undefined;
    try {
      await client.query('rollback');
    } catch (error: unknown) {
      // A connection that cannot roll back is destroyed below; the server then aborts the
      // transaction itself, so nothing persists either way.
      rollbackError = error instanceof Error ? error : new Error(String(error));
    }
    client.release(rollbackError ?? false);
  }
}

/** Inserts one fixture row through the real trigger (schema-invariants insert shape). */
async function insertFixtureRow(client: PoolClient, occurredAt?: string): Promise<FixtureRow> {
  const result: QueryResult<{
    id: string;
    occurred_at: string;
    chain_seq: string;
    prev_hash: string | null;
    row_hash: string;
    partition: string;
  }> = await client.query(
    `insert into platform.audit_log
       (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation)
     values (coalesce($1::timestamptz, now()), null, 'system', $2, 'platform', $3, $4, 'insert')
     returning id::text as id, occurred_at::text as occurred_at, chain_seq::text as chain_seq,
               prev_hash, row_hash, tableoid::regclass::text as partition`,
    [occurredAt ?? null, pccEntityId, FIXTURE_TABLE_NAME, randomUUID()],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('insert into platform.audit_log returned no row');
  }
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    chainSeq: BigInt(row.chain_seq),
    prevHash: row.prev_hash,
    rowHash: row.row_hash,
    partition: row.partition,
  };
}

async function insertFixtureRows(client: PoolClient, count: number): Promise<FixtureRow[]> {
  const rows: FixtureRow[] = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(await insertFixtureRow(client));
  }
  return rows;
}

/** Current chain head (max chain_seq, 0 when empty) and its row_hash, read on `client`. */
async function readHead(client: PoolClient): Promise<{ seq: bigint; rowHash: string | null }> {
  const result: QueryResult<{ chain_seq: string; row_hash: string | null }> = await client.query(
    `select coalesce(max(chain_seq), 0)::text as chain_seq,
            (select a.row_hash from platform.audit_log a order by a.chain_seq desc limit 1) as row_hash
       from platform.audit_log`,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('head read on platform.audit_log returned no row');
  }
  return { seq: BigInt(row.chain_seq), rowHash: row.row_hash };
}

/** Calls the §7.1 verifier with explicit columns, so the return shape itself is pinned. */
async function verifyChain(
  executor: Pool | PoolClient,
  anchor?: { seq: bigint; prevHash: string | null },
): Promise<ChainProblem[]> {
  const columns = `chain_seq::text as chain_seq, id::text as id, occurred_at::text as occurred_at,
                   problem, detail, expected_hash, actual_hash`;
  const sql = anchor
    ? `select ${columns} from platform.verify_audit_chain($1::bigint, $2::text)`
    : `select ${columns} from platform.verify_audit_chain()`;
  const params = anchor ? [anchor.seq.toString(), anchor.prevHash] : [];
  const result: QueryResult<{
    chain_seq: string | null;
    id: string | null;
    occurred_at: string | null;
    problem: string;
    detail: string | null;
    expected_hash: string | null;
    actual_hash: string | null;
  }> = await executor.query(sql, params);
  return result.rows.map((row) => ({
    chainSeq: row.chain_seq === null ? null : BigInt(row.chain_seq),
    id: row.id,
    occurredAt: row.occurred_at,
    problem: row.problem,
    detail: row.detail,
    expectedHash: row.expected_hash,
    actualHash: row.actual_hash,
  }));
}

function describeProblems(problems: readonly ChainProblem[]): string {
  return JSON.stringify(
    problems.map((p) => ({ ...p, chainSeq: p.chainSeq === null ? null : p.chainSeq.toString() })),
  );
}

/**
 * Creates a role `pgeos_t_<hex>` NOSUPERUSER NOBYPASSRLS NOLOGIN inside the caller's transaction
 * (so it is rolled back with it) and grants it USAGE on schema platform. Further grants are the
 * caller's.
 */
async function createTemporaryRole(client: PoolClient): Promise<string> {
  const name = `${TEMP_ROLE_PREFIX}${randomUUID().replace(/-/g, '')}`;
  const ident = client.escapeIdentifier(name);
  await client.query(`create role ${ident} nosuperuser nobypassrls nologin`);
  await client.query(`grant usage on schema platform to ${ident}`);
  return ident;
}

/** Grants SELECT + INSERT on platform.audit_log and USAGE on the sequence behind its id. */
async function grantAuditLogWrite(client: PoolClient, roleIdent: string): Promise<void> {
  await client.query(`grant select, insert on table platform.audit_log to ${roleIdent}`);
  const sequence: QueryResult<{ seq: string | null }> = await client.query(
    `select pg_get_serial_sequence($1, 'id') as seq`,
    [AUDIT_LOG_TABLE],
  );
  const seq = sequence.rows[0]?.seq;
  if (!seq) {
    throw new Error(`precondition: pg_get_serial_sequence('${AUDIT_LOG_TABLE}', 'id') returned null`);
  }
  // `seq` is the catalog's own quoted, schema-qualified name.
  await client.query(`grant usage on sequence ${seq} to ${roleIdent}`);
}

/** SET LOCAL ROLE + the three withContext GUCs of a non-internal user with no client. */
async function becomeNonInternalWriter(
  client: PoolClient,
  roleIdent: string,
  userId: string,
): Promise<void> {
  await client.query(`set local role ${roleIdent}`);
  await client.query(`select set_config('app.is_internal', 'false', true)`);
  await client.query(`select set_config('app.user_id', $1, true)`, [userId]);
  await client.query(`select set_config('app.client_id', $1, true)`, [null]);
}

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code: unknown = error.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function rowAt(rows: readonly FixtureRow[], index: number): FixtureRow {
  const row = rows[index];
  if (!row) {
    throw new Error(`fixture row #${index} missing`);
  }
  return row;
}

describe('platform.audit_log chain_seq — unique index on every partition (SCR-AUDIT-01 §7.1, GM condition 1)', () => {
  it('every partition of platform.audit_log, the default included, carries a valid unique index whose only key column is chain_seq', async () => {
    const result: QueryResult<{ partition: string }> = await pool.query(
      `select c.oid::regclass::text as partition
         from pg_inherits i
         join pg_class c on c.oid = i.inhrelid
        where i.inhparent = $1::regclass
          and not exists (
            select 1
              from pg_index x
              join pg_attribute att
                on att.attrelid = x.indrelid
               and att.attnum = x.indkey[0]
             where x.indrelid = c.oid
               and x.indisunique
               and x.indisvalid
               and x.indisready
               and x.indislive
               and x.indnatts = 1
               and x.indnkeyatts = 1
               and x.indexprs is null
               and x.indpred is null
               and att.attname = $2
               and not att.attisdropped
          )
        order by 1`,
      [AUDIT_LOG_TABLE, CHAIN_SEQ_COLUMN],
    );
    const offenders = result.rows.map((row) => row.partition);
    expect(
      offenders,
      `partitions of ${AUDIT_LOG_TABLE} with no index where indisunique and indisvalid and ` +
        `indisready and indislive and indnatts = 1 and indexprs is null and indpred is null and ` +
        `indkey[0] = attnum(${CHAIN_SEQ_COLUMN}): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it("negative control: a new partition created without the index is reported by verify_audit_chain() as 'partition_missing_chain_seq_unique_index' with its name in detail", async () => {
    await inRolledBackTransaction(async (client) => {
      const existing: QueryResult<{ n: string }> = await client.query(
        `select count(*)::text as n from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'platform' and c.relname = $1`,
        [NEGATIVE_CONTROL_PARTITION],
      );
      if (Number(existing.rows[0]?.n ?? '0') !== 0) {
        throw new Error(
          `precondition: platform.${NEGATIVE_CONTROL_PARTITION} already exists — the negative control needs a fresh partition`,
        );
      }

      await client.query(
        `create table platform.${NEGATIVE_CONTROL_PARTITION}
           partition of platform.audit_log
           for values from ('${NEGATIVE_CONTROL_FROM}') to ('${NEGATIVE_CONTROL_TO}')`,
      );

      const problems = (await verifyChain(client)).filter(
        (p) => p.problem === PROBLEM.partitionMissingIndex,
      );
      expect(problems, describeProblems(problems)).toHaveLength(1);
      const problem = problems[0];
      if (!problem) {
        throw new Error('no partition_missing_chain_seq_unique_index row');
      }
      expect(problem.detail ?? '').toContain(NEGATIVE_CONTROL_PARTITION);
      expect(problem.chainSeq).toBeNull();
      expect(problem.id).toBeNull();
      expect(problem.occurredAt).toBeNull();
    });
  });
});

describe('platform.audit_hash_chain() numbering — previous chain_seq + 1 under the lock (SCR-AUDIT-01 §7.1)', () => {
  it('three consecutive inserts get chain_seq h+1, h+2, h+3 and each prev_hash equals the previous row_hash', async () => {
    await inRolledBackTransaction(async (client) => {
      const head = await readHead(client);
      const rows = await insertFixtureRows(client, NUMBERING_ROWS);

      expect(rows.map((row) => row.chainSeq)).toEqual(
        Array.from({ length: NUMBERING_ROWS }, (_, index) => head.seq + BigInt(index + 1)),
      );
      expect(rowAt(rows, 0).prevHash).toBe(head.rowHash);
      for (let index = 1; index < rows.length; index += 1) {
        expect(rowAt(rows, index).prevHash).toBe(rowAt(rows, index - 1).rowHash);
      }
    });
  });

  it('a rolled-back insert leaves no gap: the next insert reuses h+1 and verify_audit_chain() returns zero rows', async () => {
    await inRolledBackTransaction(async (client) => {
      const before = await verifyChain(client);
      expect(
        before,
        `precondition: verify_audit_chain() must be clean before the scenario — ${describeProblems(before)}; ` +
          'start from a clean database: bash database/schema/apply.sh --recreate',
      ).toEqual([]);

      const head = await readHead(client);
      await client.query('savepoint audit_chain_seq_rollback');
      const discarded = await insertFixtureRow(client);
      expect(discarded.chainSeq).toBe(head.seq + 1n);
      await client.query('rollback to savepoint audit_chain_seq_rollback');

      const kept = await insertFixtureRow(client);
      expect(kept.chainSeq).toBe(head.seq + 1n);
      expect(kept.prevHash).toBe(head.rowHash);

      const after = await verifyChain(client);
      expect(after, describeProblems(after)).toEqual([]);
    });
  });
});

describe('platform.verify_audit_chain() detects gaps, duplicates and tampering (SCR-AUDIT-01 §7.1)', () => {
  it("deleting a middle row is reported as 'chain_seq_gap' at the next row's chain_seq", async () => {
    await inRolledBackTransaction(async (client) => {
      const rows = await insertFixtureRows(client, GAP_ROWS);
      const middle = rowAt(rows, 1);
      const third = rowAt(rows, 2);

      const deleted = await client.query(
        `delete from platform.audit_log where id = $1 and occurred_at = $2::timestamptz`,
        [middle.id, middle.occurredAt],
      );
      expect(deleted.rowCount).toBe(1);

      const problems = await verifyChain(client);
      // A prev_hash_mismatch on the same row is also correct — membership, not exact count.
      expect(
        problems.some((p) => p.problem === PROBLEM.chainSeqGap && p.chainSeq === third.chainSeq),
        describeProblems(problems),
      ).toBe(true);
    });
  });

  it("two rows in different partitions with the same chain_seq are reported as 'duplicate_chain_seq'", async () => {
    await inRolledBackTransaction(async (client) => {
      const current = await insertFixtureRow(client);
      const inDefault = await insertFixtureRow(client, DEFAULT_PARTITION_OCCURRED_AT);
      if (inDefault.partition !== DEFAULT_PARTITION || current.partition === inDefault.partition) {
        throw new Error(
          `precondition: the two rows must sit in two different partitions, the second in ${DEFAULT_PARTITION} ` +
            `(got ${current.partition} and ${inDefault.partition})`,
        );
      }

      const updated = await client.query(
        `update platform.audit_log set chain_seq = $3::bigint
          where id = $1 and occurred_at = $2::timestamptz`,
        [inDefault.id, inDefault.occurredAt, current.chainSeq.toString()],
      );
      expect(updated.rowCount).toBe(1);

      const problems = await verifyChain(client);
      expect(
        problems.some(
          (p) => p.problem === PROBLEM.duplicateChainSeq && p.chainSeq === current.chainSeq,
        ),
        describeProblems(problems),
      ).toBe(true);
    });
  });

  it("a tampered row_hash is reported as 'hash_mismatch' for that row", async () => {
    await inRolledBackTransaction(async (client) => {
      const target = await insertFixtureRow(client);

      const updated = await client.query(
        `update platform.audit_log set row_hash = $3
          where id = $1 and occurred_at = $2::timestamptz`,
        [target.id, target.occurredAt, TAMPERED_ROW_HASH],
      );
      expect(updated.rowCount).toBe(1);

      const problems = await verifyChain(client);
      expect(
        problems.some(
          (p) =>
            p.problem === PROBLEM.hashMismatch &&
            p.id === target.id &&
            p.chainSeq === target.chainSeq &&
            p.actualHash === TAMPERED_ROW_HASH &&
            p.expectedHash === target.rowHash,
        ),
        describeProblems(problems),
      ).toBe(true);
    });
  });
});

describe('platform.verify_audit_chain(p_anchor_seq, p_anchor_prev_hash) — verification anchor (SCR-AUDIT-01 §7.1, GM condition 3)', () => {
  it('after every row below the anchor is removed, the default call reports a problem, the correct anchor verifies clean, and a wrong anchor prev_hash is reported as prev_hash_mismatch', async () => {
    await inRolledBackTransaction(async (client) => {
      const rows = await insertFixtureRows(client, ANCHOR_ROWS);
      const anchorRow = rowAt(rows, ANCHOR_ROW_INDEX);
      const anchorSeq = anchorRow.chainSeq;
      const anchorPrev = anchorRow.prevHash;
      expect(anchorSeq).toBe(rowAt(rows, 0).chainSeq + BigInt(ANCHOR_ROW_INDEX));

      // Simulates detached/archived history: ALL earlier rows of the whole table go (rolled back).
      await client.query(`delete from platform.audit_log where chain_seq < $1::bigint`, [
        anchorSeq.toString(),
      ]);

      const withDefaultAnchor = await verifyChain(client);
      expect(
        withDefaultAnchor.some(
          (p) =>
            p.chainSeq === anchorSeq &&
            (p.problem === PROBLEM.chainSeqGap || p.problem === PROBLEM.prevHashMismatch),
        ),
        describeProblems(withDefaultAnchor),
      ).toBe(true);

      const withAnchor = await verifyChain(client, { seq: anchorSeq, prevHash: anchorPrev });
      expect(withAnchor, describeProblems(withAnchor)).toEqual([]);

      const withWrongAnchor = await verifyChain(client, {
        seq: anchorSeq,
        prevHash: WRONG_ANCHOR_PREV_HASH,
      });
      expect(
        withWrongAnchor.some(
          (p) => p.problem === PROBLEM.prevHashMismatch && p.chainSeq === anchorSeq,
        ),
        describeProblems(withWrongAnchor),
      ).toBe(true);
    });
  });
});

describe('platform.audit_hash_chain() refuses audited writes outside READ COMMITTED (pg-reviewer migration gate)', () => {
  it('a transaction under REPEATABLE READ that inserts into platform.audit_log is refused', async () => {
    const client = await pool.connect();
    let rollbackError: Error | undefined;
    try {
      await client.query('begin isolation level repeatable read');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [AUDIT_CHAIN_LOCK_KEY]);

      let thrown: unknown = null;
      try {
        // Plain insert, no chain_seq in RETURNING: the only reason this may fail is the trigger's
        // isolation check, not a missing column.
        await client.query(
          `insert into platform.audit_log
             (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation)
           values (now(), null, 'system', $1, 'platform', $2, $3, 'insert')
           returning id`,
          [pccEntityId, FIXTURE_TABLE_NAME, randomUUID()],
        );
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown, 'the insert under REPEATABLE READ was accepted').toBeInstanceOf(Error);
      const message = thrown instanceof Error ? thrown.message : '';
      expect(message).toMatch(READ_COMMITTED_PHRASE);
    } finally {
      try {
        await client.query('rollback');
      } catch (error: unknown) {
        rollbackError = error instanceof Error ? error : new Error(String(error));
      }
      client.release(rollbackError ?? false);
    }
  });
});

describe('platform.audit_log row_hash rendering is pinned (pg-reviewer migration gate)', () => {
  it('row_hash rendering is pinned (timezone/datestyle): a row written under Asia/Kolkata verifies clean under America/New_York', async () => {
    await inRolledBackTransaction(async (client) => {
      await client.query(`select set_config('timezone', $1, true)`, [WRITE_TIMEZONE]);
      await client.query(`select set_config('datestyle', $1, true)`, [WRITE_DATESTYLE]);
      const written = await insertFixtureRow(client);

      await client.query(`select set_config('timezone', $1, true)`, [VERIFY_TIMEZONE]);
      await client.query(`select set_config('datestyle', $1, true)`, [VERIFY_DATESTYLE]);
      const problems = (await verifyChain(client)).filter(
        (p) => p.id === written.id || p.chainSeq === written.chainSeq,
      );
      expect(problems, describeProblems(problems)).toEqual([]);
    });
  });
});

describe('platform.audit_hash_chain() is SECURITY DEFINER — the head lookup ignores the writer\'s RLS view (SCR-AUDIT-01 §7.1, pg-reviewer round 2)', () => {
  it('a non-internal writer that cannot see the chain head still chains after it', async () => {
    await inRolledBackTransaction(async (client) => {
      // As superuser: the head row carries the PCC entity, so entity_scope hides it from a user
      // with no identity.user_entities row.
      const head = await insertFixtureRow(client);
      const role = await createTemporaryRole(client);
      await grantAuditLogWrite(client, role);
      const writerUserId = randomUUID();

      await becomeNonInternalWriter(client, role, writerUserId);

      // SELECT is granted, so a zero count here is RLS hiding the head — not a missing privilege.
      const visible: QueryResult<{ n: string }> = await client.query(
        `select count(*)::text as n from platform.audit_log where chain_seq = $1::bigint`,
        [head.chainSeq.toString()],
      );
      expect(visible.rows[0]?.n, 'the head row must be invisible to the writer under RLS').toBe('0');

      // entity_id NULL is allowed by entity_scope; RETURNING only id and occurred_at.
      const inserted: QueryResult<{ id: string; occurred_at: string }> = await client.query(
        `insert into platform.audit_log
           (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation)
         values (now(), $1, 'user', null, 'platform', $2, $3, 'insert')
         returning id::text as id, occurred_at::text as occurred_at`,
        [writerUserId, FIXTURE_TABLE_NAME, randomUUID()],
      );
      const writerRow = inserted.rows[0];
      if (!writerRow) {
        throw new Error('insert into platform.audit_log as the non-internal writer returned no row');
      }

      await client.query('reset role');

      const readBack: QueryResult<{ chain_seq: string; prev_hash: string | null }> =
        await client.query(
          `select chain_seq::text as chain_seq, prev_hash
             from platform.audit_log where id = $1 and occurred_at = $2::timestamptz`,
          [writerRow.id, writerRow.occurred_at],
        );
      const stored = readBack.rows[0];
      if (!stored) {
        throw new Error('the writer row could not be read back as superuser');
      }
      expect(BigInt(stored.chain_seq)).toBe(head.chainSeq + 1n);
      expect(stored.prev_hash).toBe(head.rowHash);

      const problems = (await verifyChain(client)).filter(
        (p) => p.id === writerRow.id || p.chainSeq === head.chainSeq + 1n,
      );
      expect(problems, describeProblems(problems)).toEqual([]);
    });
  });
});

describe('platform.verify_audit_chain() — rights and anchor validation (SCR-AUDIT-01 §7.1, pg-reviewer round 2)', () => {
  it("a role without the owner's rights cannot run the verifier", async () => {
    await inRolledBackTransaction(async (client) => {
      const role = await createTemporaryRole(client);
      // SELECT on the table is granted too, so the refusal can only come from the function's
      // EXECUTE privilege — never from the table (an invoker-rights verifier would run here).
      await client.query(`grant select on table platform.audit_log to ${role}`);
      await client.query(`set local role ${role}`);

      let thrown: unknown = null;
      let returnedRows: number | null = null;
      try {
        const result = await client.query('select * from platform.verify_audit_chain()');
        returnedRows = result.rows.length;
      } catch (error: unknown) {
        thrown = error;
      }

      expect(
        thrown,
        `verify_audit_chain() ran for a role without the owner's rights and returned ${String(returnedRows)} row(s)`,
      ).toBeInstanceOf(Error);
      expect(sqlStateOf(thrown)).toBe(SQLSTATE_INSUFFICIENT_PRIVILEGE);
      expect(thrown instanceof Error ? thrown.message : '').toContain(VERIFIER_FUNCTION_NAME);
    });
  });

  it('a NULL anchor is reported, not silently clean', async () => {
    const result: QueryResult<{ problem: string }> = await pool.query(
      `select problem from platform.verify_audit_chain($1::bigint, $2::text)`,
      [null, null],
    );
    const problems = result.rows.map((row) => row.problem);
    expect(problems, JSON.stringify(problems)).toContain(PROBLEM.anchorInvalid);
  });

  it('an anchor above the head is reported', async () => {
    await inRolledBackTransaction(async (client) => {
      await insertFixtureRow(client);
      const head = await readHead(client);
      const anchorSeq = head.seq + ANCHOR_ABOVE_HEAD_OFFSET;

      const result: QueryResult<{ problem: string }> = await client.query(
        `select problem from platform.verify_audit_chain($1::bigint, $2::text)`,
        [anchorSeq.toString(), null],
      );
      const problems = result.rows.map((row) => row.problem);
      expect(problems, JSON.stringify(problems)).toContain(PROBLEM.anchorNotFound);
    });
  });
});

describe('G8 whole-table contract (doc 40 Part F)', () => {
  it('outside any transaction, select * from platform.verify_audit_chain() returns zero rows', async () => {
    const result: QueryResult<Record<string, unknown>> = await pool.query(
      'select * from platform.verify_audit_chain()',
    );
    expect(result.rows).toEqual([]);
  });
});
