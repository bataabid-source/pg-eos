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
//
// Exception to "no RED phase": the last two describe blocks (SCR-AUDIT-01 §7.1, GM condition 1,
// pg-reviewer migration-gate finding 9; pg-reviewer round 2 definer rights) are written before the
// approved migration and are RED until platform.audit_log.chain_seq, its per-partition unique index
// and the SECURITY DEFINER, PUBLIC-revoked chain functions exist.

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

// SCR-AUDIT-01 §7.1, GM condition 1 (pg-reviewer migration-gate finding 9). The same property is
// also pinned in audit-chain-seq.test.ts; GM condition 1 requires it here too. The index is found
// by its pg_index PROPERTIES only — never by its name — so a correctly shaped index under any name
// passes and a wrongly shaped index under the expected name fails.
const AUDIT_LOG_TABLE = 'platform.audit_log';
const AUDIT_LOG_DEFAULT_PARTITION = 'platform.audit_log_default';
const CHAIN_SEQ_COLUMN = 'chain_seq';
const PARTITION_MISSING_INDEX_PROBLEM = 'partition_missing_chain_seq_unique_index';

describe('platform.audit_log — every partition carries a unique index on chain_seq (SCR-AUDIT-01 §7.1, GM condition 1)', () => {
  it('every partition (pg_inherits, default included) has a unique, valid, predicate-free, expression-free single-column index on chain_seq, and verify_audit_chain() reports no partition_missing_chain_seq_unique_index row', async () => {
    const partitions: QueryResult<{ partition: string; has_chain_seq_unique_index: boolean }> =
      await pool.query(
        `select c.oid::regclass::text as partition,
                exists (
                  select 1
                    from pg_index x
                   where x.indrelid = c.oid
                     and x.indisunique
                     and x.indisvalid
                     and x.indpred is null
                     and x.indexprs is null
                     and x.indnatts = 1
                     and x.indkey[0] = (
                       select att.attnum
                         from pg_attribute att
                        where att.attrelid = c.oid
                          and att.attname = $2
                          and not att.attisdropped
                     )
                ) as has_chain_seq_unique_index
           from pg_inherits i
           join pg_class c on c.oid = i.inhrelid
          where i.inhparent = $1::regclass
          order by 1`,
        [AUDIT_LOG_TABLE, CHAIN_SEQ_COLUMN],
      );

    const partitionNames = partitions.rows.map((row) => row.partition);
    // Vacuity guard: an empty partition list would make "no offenders" trivially true.
    expect(partitionNames, `partitions of ${AUDIT_LOG_TABLE} per pg_inherits`).toContain(
      AUDIT_LOG_DEFAULT_PARTITION,
    );

    const offenders = partitions.rows
      .filter((row) => !row.has_chain_seq_unique_index)
      .map((row) => row.partition);
    expect(
      offenders,
      `partitions of ${AUDIT_LOG_TABLE} with no index where indisunique and indisvalid and indpred ` +
        `is null and indexprs is null and indnatts = 1 and indkey[0] = attnum(${CHAIN_SEQ_COLUMN}): ` +
        offenders.join(', '),
    ).toEqual([]);

    const reported: QueryResult<Record<string, unknown>> = await pool.query(
      'select * from platform.verify_audit_chain() where problem = $1',
      [PARTITION_MISSING_INDEX_PROBLEM],
    );
    expect(reported.rows, JSON.stringify(reported.rows)).toEqual([]);
  });
});

// SCR-AUDIT-01 §7.1 + §7.5 findings 1–2 (pg-reviewer round 2): both chain functions are SECURITY
// DEFINER, owned by a role that bypasses RLS (superuser or BYPASSRLS — otherwise FORCE RLS on
// platform.audit_log still applies to the owner and the head lookup forks the chain), and PUBLIC
// cannot execute them. A NULL proacl means the default ACL, which grants EXECUTE to PUBLIC — so the
// ACL is read through acldefault() when proacl is null, never through aclexplode(null) (vacuous).
const CHAIN_FUNCTION_NAMES = ['audit_hash_chain', 'verify_audit_chain'] as const;
const DEFINER_OWNER_PROBLEM = 'definer_owner_cannot_bypass_rls';
// aclexplode(): grantee oid 0 is PUBLIC.
const PUBLIC_GRANTEE_OID = 0;

describe('platform.audit_hash_chain / platform.verify_audit_chain — definer rights (SCR-AUDIT-01 §7.1, pg-reviewer round 2)', () => {
  it('both chain functions are SECURITY DEFINER, owned by a superuser or BYPASSRLS role, not executable by PUBLIC, and verify_audit_chain() reports no definer_owner_cannot_bypass_rls row', async () => {
    const reported: QueryResult<Record<string, unknown>> = await pool.query(
      'select * from platform.verify_audit_chain() where problem = $1',
      [DEFINER_OWNER_PROBLEM],
    );
    expect(reported.rows, JSON.stringify(reported.rows)).toEqual([]);

    const functions: QueryResult<{
      signature: string;
      proname: string;
      prosecdef: boolean;
      owner: string;
      owner_bypasses_rls: boolean;
      public_can_execute: boolean;
    }> = await pool.query(
      `select p.oid::regprocedure::text as signature,
              p.proname::text as proname,
              p.prosecdef,
              r.rolname::text as owner,
              (r.rolsuper or r.rolbypassrls) as owner_bypasses_rls,
              exists (
                select 1
                  from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                 where acl.grantee = $2
                   and acl.privilege_type = 'EXECUTE'
              ) as public_can_execute
         from pg_proc p
         join pg_roles r on r.oid = p.proowner
        where p.pronamespace = 'platform'::regnamespace
          and p.proname = any($1::text[])
        order by 1`,
      [CHAIN_FUNCTION_NAMES, PUBLIC_GRANTEE_OID],
    );

    // Vacuity guard: both functions must be found, or "no offender" is trivially true.
    expect([...new Set(functions.rows.map((row) => row.proname))].sort()).toEqual(
      [...CHAIN_FUNCTION_NAMES].sort(),
    );

    const offenders = functions.rows
      .filter((row) => !row.prosecdef || !row.owner_bypasses_rls || row.public_can_execute)
      .map(
        (row) =>
          `${row.signature} (prosecdef=${String(row.prosecdef)}, owner=${row.owner}, ` +
          `owner rolsuper or rolbypassrls=${String(row.owner_bypasses_rls)}, ` +
          `PUBLIC EXECUTE=${String(row.public_can_execute)})`,
      );
    expect(offenders, offenders.join('; ')).toEqual([]);
  });
});

// SCR-TRGM-01 (environment-wide, not sales-specific) — GM-approved option A, 2026-09-23
// (docs/notes/slice-briefs/_slice-1.5.brief.md decision 7): databases are created with lc_ctype C.UTF-8,
// lc_collate C, so that pg_trgm produces real trigrams for Arabic (and other non-ASCII) text.
// Under the old plain-C ctype, show_trgm() returns an empty array for any non-ASCII input — this
// describe block is the permanent, re-runnable proof that this database's ctype/collate actually
// deliver working Arabic trigrams, not merely that the pg_trgm extension is installed. This is
// asserted here, at the platform level, because it governs every module's use of pg_trgm on
// Arabic columns (starting with modules/sales/tests/integration/customer-accounts.test.ts), not
// only sales.
const EXPECTED_DATCTYPE = 'C.UTF-8';
const EXPECTED_DATCOLLATE = 'C';
// "warehouse" — a plain Arabic dictionary word used only to probe trigram extraction; not a
// fixture, not a business value (CLAUDE.md AGENT CONSTRAINTS — never fabricate a name).
const ARABIC_TRIGRAM_PROBE_WORD = 'مخزن';

// WBS 2.9 follow-up — migration 0009 (database/migrations/0009_M_next-doc-no-definer.sql):
// platform.next_doc_no is now SECURITY DEFINER with an explicit gate (caller must be
// platform.is_internal() and p_entity must be in platform.allowed_entities(), unless the session
// role itself bypasses RLS). Proved here, as pgeos_app (the non-superuser application role,
// migration 0007), with the SAME set_config(...) GUCs packages/db/src/with-context.ts sets
// (app.user_id / app.client_id / app.is_internal) — never hand-rolled differently. Each call runs
// inside its own begin/rollback on a dedicated pgeos_app-role pool so a successful allocation's
// platform.counters increment is never left behind (brief: "counter increments are acceptable side
// effects: don't try to roll the counter back" — rollback is simply the cleanest way to honor
// that). platform.audit_log is never touched by this block.
const appPool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PG_APP_USER'] ?? 'pgeos_app',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

const NEXT_DOC_NO_FIXTURE_USER_UUID = '00000000-0000-4000-8000-0000000209b1';
let pstEntityId: string;

describe('platform.next_doc_no — SECURITY DEFINER gate as pgeos_app (migration 0009)', () => {
  beforeAll(async () => {
    const pstResult: QueryResult<{ id: string }> = await pool.query(
      `select id from platform.entities where code = $1`,
      ['PST'],
    );
    const pstRow = pstResult.rows[0];
    if (!pstRow) throw new Error("seed entity 'PST' not found in platform.entities");
    pstEntityId = pstRow.id;

    // Real identity.users + identity.user_entities rows, created/cleaned through the admin
    // connection — same fixture pattern as modules/wms/tests/integration/stock-ledger.test.ts.
    // Granted PCC only — PST stays outside this user's allowed_entities() for scenario 2.
    await pool.query(`delete from identity.user_entities where user_id = $1`, [
      NEXT_DOC_NO_FIXTURE_USER_UUID,
    ]);
    await pool.query(`delete from identity.users where id = $1`, [NEXT_DOC_NO_FIXTURE_USER_UUID]);
    await pool.query(
      `insert into identity.users (id, email, full_name_ar, user_type)
       values ($1, $2, $3, 'internal')`,
      [
        NEXT_DOC_NO_FIXTURE_USER_UUID,
        `_nextdocno_fixture_${randomUUID()}@test.invalid`,
        'ممثل اختبار next_doc_no — WBS 2.9 follow-up',
      ],
    );
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [
      NEXT_DOC_NO_FIXTURE_USER_UUID,
      pccEntityId,
    ]);
  });

  afterAll(async () => {
    await pool.query(`delete from identity.user_entities where user_id = $1`, [
      NEXT_DOC_NO_FIXTURE_USER_UUID,
    ]);
    await pool.query(`delete from identity.users where id = $1`, [NEXT_DOC_NO_FIXTURE_USER_UUID]);
    await appPool.end();
  });

  it('next_doc_no as pgeos_app allocates a number for an entity the internal caller holds', async () => {
    // 'DOC'/'ALL' against PCC already has a live platform.counters row — reused, never invented
    // (same counter the WBS 0.9 acceptance-#1 describe block above allocates against).
    const client = await appPool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.user_id', $1, true)`, [
        NEXT_DOC_NO_FIXTURE_USER_UUID,
      ]);
      await client.query(`select set_config('app.client_id', $1, true)`, [null]);
      await client.query(`select set_config('app.is_internal', 'true', true)`);

      const result: QueryResult<{ next_doc_no: string }> = await client.query(
        `select platform.next_doc_no($1, $2, $3) as next_doc_no`,
        [pccEntityId, 'DOC', 'ALL'],
      );
      expect(result.rows[0]?.next_doc_no).toMatch(/^PCC-DC-\d{5}$/);

      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('next_doc_no as pgeos_app for an entity outside allowed_entities() is refused with 42501', async () => {
    const client = await appPool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.user_id', $1, true)`, [
        NEXT_DOC_NO_FIXTURE_USER_UUID,
      ]);
      await client.query(`select set_config('app.client_id', $1, true)`, [null]);
      await client.query(`select set_config('app.is_internal', 'true', true)`);

      // The fixture user's user_entities row only ever granted PCC (beforeAll) — PST is a real,
      // seeded entity outside that scope.
      await expect(
        client.query(`select platform.next_doc_no($1, $2, $3) as next_doc_no`, [
          pstEntityId,
          'DOC',
          'ALL',
        ]),
      ).rejects.toMatchObject({ code: '42501' });

      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('next_doc_no as pgeos_app with no context (no app.user_id / is_internal) is refused with 42501', async () => {
    const client = await appPool.connect();
    try {
      await client.query('begin');
      // Deliberately no set_config(...) calls at all — a fresh transaction carries no
      // app.user_id/app.client_id/app.is_internal GUC, exactly like a connection that never went
      // through withContext(ctx, fn).
      await expect(
        client.query(`select platform.next_doc_no($1, $2, $3) as next_doc_no`, [
          pccEntityId,
          'DOC',
          'ALL',
        ]),
      ).rejects.toMatchObject({ code: '42501' });

      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});

describe('the database ctype supports Arabic trigrams (SCR-TRGM-01)', () => {
  it('datctype is C.UTF-8, datcollate is C, and show_trgm() returns real trigrams for Arabic text', async () => {
    const dbSettings: QueryResult<{ datctype: string; datcollate: string }> = await pool.query(
      `select datctype, datcollate from pg_database where datname = current_database()`,
    );
    expect(dbSettings.rows[0]?.datctype).toBe(EXPECTED_DATCTYPE);
    expect(dbSettings.rows[0]?.datcollate).toBe(EXPECTED_DATCOLLATE);

    const trigrams: QueryResult<{ trigrams: string[] }> = await pool.query(
      `select show_trgm($1::text) as trigrams`,
      [ARABIC_TRIGRAM_PROBE_WORD],
    );
    expect(trigrams.rows[0]?.trigrams).not.toEqual([]);
  });
});
