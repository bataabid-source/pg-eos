// modules/billing/tests/post-journal/post-journal.test.ts — WBS 4.20 (lane 2), posting engine.
//
// Integration tests against the real database (pgeos_lane2 — MUST be run with
// `PGDATABASE=pgeos_lane2` exported in the SAME shell command). Admin pool (PGUSER, bypasses RLS)
// for fixtures and every "the database itself rejects/accepts this" proof; `withContext` as a genuine
// pgeos_app session for RLS/grant scenarios; the application layer for the posting service. One
// `describe` per ./post-journal.feature Scenario, title matching EXACTLY.
//
// STATUS: RED — nothing is built. Expected first failure: the imports below do not resolve
// (modules/billing/{domain,application,api}/post-journal/* still hold the golden-slice wms content),
// and database/migrations/0041_2_post-journal.sql (SCR-ACC-01 #5-#8) is not applied.
//
// D-183: no DELETE commits outside this suite's own afterAll, which removes only its own tracked rows
// (under session_replication_role = replica, ./fixtures.ts); no TRUNCATE is ever run. Immutability
// refusals are asserted from the catalog and from always-rolled-back transactions.
//
// Application surface this file exercises (builder must provide, names verbatim):
//   modules/billing/application/post-journal/index.ts
//     - postJournal(ctx, { entityId, periodId, entryDate, entryType, description, lines, correlationId, idem? }, deps)
//         : Promise<{ id: string; docNo: string; version: number }>   (version 1, entry posted)
//     - reverseJournal(ctx, { entryId, expectedVersion, periodId, entryDate, description, correlationId, idem? }, deps)
//         : Promise<{ id: string; docNo: string; reversedEntryId: string; originalVersion: number }>
//         (id/docNo = the NEW 'reversing' entry; originalVersion = the original's version after the bump)
//     - adjustJournal(ctx, { entityId, periodId, entryDate, description, lines, correlationId, idem? }, deps)
//         : Promise<{ id: string; docNo: string; version: number }>
//     lines: { accountId, debit?, credit?, description? }[] (decimal strings, contract JournalLineInput).
//   modules/billing/api/post-journal/composition.ts — createPostJournalDeps({ clock, logger? }).
//   modules/billing/domain/post-journal/errors.ts — see ./errors.unit.test.ts.
// Outbox: event_type 'billing.journal_entry.posted' | '.adjusted' | '.reversed' (packages/events/catalog.ts:134-136),
//   aggregate_type 'billing.journal_entries'; aggregate_id = the new entry's id for posted/adjusted, the
//   ORIGINAL entry's id for reversed. One platform.audit_log row per posting (>= 1 for a reversal).
// Design defaults recorded: PostJournal / AdjustJournal / ReverseJournal carry no role gate (the design
//   names none); every typed refusal happens BEFORE any write (nothing in outbox/audit for its correlationId).

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WithContextCtx } from '@pg-eos/db';
import { withContext, type IdempotencyInput } from '@pg-eos/db';
import { FixedClock } from '@pg-eos/domain-kit';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { adjustJournal, postJournal, reverseJournal } from '../../application/post-journal/index.js';
import { createPostJournalDeps } from '../../api/post-journal/composition.js';
import {
  AccountNotInEntityError,
  AccountNotPostableError,
  AlreadyReversedError,
  EntityNotInScopeError,
  InsufficientLinesError,
  JournalEntryNotFoundError,
  ManualJournalApprovalRequiredError,
  ManualRevenueJournalRefusedError,
  PeriodNotOpenError,
  RoleRequiredError,
  StaleVersionError,
  UnbalancedEntryError,
} from '../../domain/post-journal/errors.js';
import { createFixtures, type Fixtures } from './fixtures.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const CHECK_VIOLATION = '23514';
const INSUFFICIENT_PRIVILEGE = '42501';
const BALANCE_CONSTRAINT = 'chk_journal_entry_balanced';

const POSTED_EVENT = 'billing.journal_entry.posted';
const ADJUSTED_EVENT = 'billing.journal_entry.adjusted';
const REVERSED_EVENT = 'billing.journal_entry.reversed';
const ENTRIES_AGGREGATE = 'billing.journal_entries';
const ENTRY_TYPES = ['manual', 'recurring', 'reversing', 'adjustment', 'accrual', 'prepayment', 'closing'] as const;

const AMOUNT = '100.000';
const FILE_NO = '01';
const STALE_VERSION = 999; // far above any real version; matches the .feature (expectedVersion 999).

const clock = new FixedClock(new Date('2026-09-29T00:00:00.000Z'));
const deps = createPostJournalDeps({ clock });

let fx: Fixtures;
const usedCorrelationIds = new Set<string>();

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

function idemFor(endpoint: string, key: string, body: unknown): IdempotencyInput {
  return {
    key,
    endpoint: `billing.post-journal.${endpoint}`,
    requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    entityId: null,
    successStatus: 200,
  };
}

function findRaisedException(error: unknown, sqlstate: string): Error | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? (current as { code?: unknown }).code : undefined;
    if (code === sqlstate) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function ctxFor(userId: string): WithContextCtx {
  return fx.ctx(userId);
}

function balancedLines(): Array<{ accountId: string; debit?: string; credit?: string }> {
  return [
    { accountId: fx.accounts.debit, debit: AMOUNT },
    { accountId: fx.accounts.credit, credit: AMOUNT },
  ];
}

/** A posted, balanced 'accrual' entry via the real posting service, in a fresh open period. */
async function postFresh(): Promise<{ id: string; docNo: string; version: number; periodId: string; entryDate: string }> {
  const period = await fx.nextPeriod();
  const result = await postJournal(
    ctxFor(fx.posterId),
    {
      entityId: fx.entityId,
      periodId: period.id,
      entryDate: period.startDate,
      entryType: 'accrual',
      description: 'قيد اختبار محرك الترحيل — WBS 4.20',
      lines: balancedLines(),
      correlationId: nextCorrelationId(),
    },
    deps,
  );
  fx.trackEntry(result.id);
  return { ...result, periodId: period.id, entryDate: period.startDate };
}

async function outboxRows(correlationId: string, eventType?: string): Promise<Array<{ event_type: string; aggregate_id: string; aggregate_type: string }>> {
  const result: QueryResult<{ event_type: string; aggregate_id: string; aggregate_type: string }> = await pool.query(
    `select event_type, aggregate_id::text as aggregate_id, aggregate_type from platform.outbox
      where correlation_id = $1 and ($2::text is null or event_type = $2)`,
    [correlationId, eventType ?? null],
  );
  return result.rows;
}

async function auditCount(correlationId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(`select count(*)::text as n from platform.audit_log where correlation_id = $1`, [correlationId]);
  return Number(result.rows[0]?.n ?? '0');
}

async function assertNoWrite(correlationId: string): Promise<void> {
  expect(await outboxRows(correlationId)).toHaveLength(0);
  expect(await auditCount(correlationId)).toBe(0);
}

async function getEntry(id: string): Promise<{
  entity_id: string;
  doc_no: string;
  entry_type: string;
  posted_at: Date | null;
  posted_by: string | null;
  reversed_by: string | null;
  version: number;
  period_id: string | null;
}> {
  const result = await pool.query(
    `select entity_id::text as entity_id, doc_no, entry_type, posted_at, posted_by::text as posted_by, reversed_by::text as reversed_by, version, period_id::text as period_id
       from billing.journal_entries where id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no billing.journal_entries row for id ${id}`);
  return row;
}

async function getLines(entryId: string): Promise<Array<{ account_id: string; debit: string; credit: string }>> {
  const result: QueryResult<{ account_id: string; debit: string; credit: string }> = await pool.query(
    `select account_id::text as account_id, debit::text as debit, credit::text as credit from billing.journal_lines where entry_id = $1 order by account_id, debit`,
    [entryId],
  );
  return result.rows;
}

/** Runs `text` as the TABLE OWNER (admin pool) inside a transaction that is ALWAYS rolled back, and
 *  returns the SQLSTATE it raised (undefined if it did not raise). Nothing is ever committed (D-183). */
async function ownerRolledBack(text: string, params: unknown[]): Promise<string | undefined> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    try {
      await client.query(text, params);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

/** Runs `run` inside a genuine pgeos_app session that always ends rolled back (the sentinel throw). */
class RolledBack extends Error {}
async function appRolledBack(userId: string, run: (tx: NodePgDatabase) => Promise<unknown>): Promise<unknown> {
  try {
    await withContext(ctxFor(userId), async (tx: NodePgDatabase) => {
      await run(tx);
      throw new RolledBack('always rolled back');
    });
  } catch (error) {
    if (error instanceof RolledBack) return undefined;
    return error;
  }
  return undefined;
}

/** Inserts an entry then its lines one statement at a time as the owner, then commits. */
async function commitLineByLine(input: {
  entryType?: string;
  periodId: string;
  entryDate: string;
  lines: ReadonlyArray<{ accountId: string; debit: string; credit: string }>;
}): Promise<{ entryId: string; docNo: string; error?: { code?: string; message: string; constraint?: string } }> {
  const client = await pool.connect();
  const docNo = `JE-POSTJ-${randomUUID().slice(0, 12)}`;
  let entryId = '';
  try {
    await client.query('begin');
    const inserted = await client.query<{ id: string }>(
      `insert into billing.journal_entries (entity_id, doc_no, entry_date, description, period_id, entry_type, posted_at, posted_by)
       values ($1, $2, $3, $4, $5, $6, now(), $7) returning id`,
      [fx.entityId, docNo, input.entryDate, 'قيد اختبار سطرًا بسطر — WBS 4.20', input.periodId, input.entryType ?? 'accrual', fx.posterId],
    );
    entryId = inserted.rows[0]?.id ?? '';
    fx.trackEntry(entryId);
    for (const line of input.lines) {
      await client.query(`insert into billing.journal_lines (entry_id, account_id, debit, credit) values ($1, $2, $3, $4)`, [entryId, line.accountId, line.debit, line.credit]);
    }
    await client.query('commit');
    return { entryId, docNo };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    const err = error as { code?: string; message: string; constraint?: string };
    return { entryId, docNo, error: err };
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  fx = await createFixtures(pool, { tag: 'post-journal.test', fileNo: FILE_NO });
  const currentUser = await withContext(ctxFor(fx.posterId), async (tx: NodePgDatabase) => tx.execute<{ current_user: string }>(sql`select current_user`));
  expect(currentUser.rows[0]?.['current_user']).toBe('pgeos_app');
});

afterAll(async () => {
  try {
    await fx.cleanup();
  } finally {
    await pool.end();
  }
});

// --- Scenario 1 ---------------------------------------------------------------------------------------

describe('Scenario: A balanced entry posts through the posting service with one outbox row and one audit row in the same transaction', () => {
  it('the entry is posted (version 1, posted_at/by, entry_type, doc_no from next_doc_no), lines stored as given, one outbox row and one audit row', async () => {
    const period = await fx.nextPeriod();
    const correlationId = nextCorrelationId();
    const result = await postJournal(
      ctxFor(fx.posterId),
      {
        entityId: fx.entityId,
        periodId: period.id,
        entryDate: period.startDate,
        entryType: 'accrual',
        description: 'قيد ترحيل متوازن — WBS 4.20',
        lines: balancedLines(),
        correlationId,
      },
      deps,
    );
    fx.trackEntry(result.id);

    expect(result.version).toBe(1);
    const prefix = await fx.jeCounterPrefix(fx.entityId);
    expect(result.docNo.startsWith(prefix)).toBe(true);

    const entry = await getEntry(result.id);
    expect(entry.entity_id).toBe(fx.entityId);
    expect(entry.doc_no).toBe(result.docNo);
    expect(entry.entry_type).toBe('accrual');
    expect(entry.posted_at).not.toBeNull();
    expect(entry.posted_by).toBe(fx.posterId);
    expect(entry.version).toBe(1);
    expect(entry.reversed_by).toBeNull();
    expect(entry.period_id).toBe(period.id);

    const lines = await getLines(result.id);
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.account_id === fx.accounts.debit)).toMatchObject({ debit: AMOUNT, credit: '0.000' });
    expect(lines.find((l) => l.account_id === fx.accounts.credit)).toMatchObject({ debit: '0.000', credit: AMOUNT });

    const events = await outboxRows(correlationId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: POSTED_EVENT, aggregate_id: result.id, aggregate_type: ENTRIES_AGGREGATE });
    expect(await auditCount(correlationId)).toBe(1);
  });

  it('the posted entry is visible with its lines to a caller scoped to the entity (RLS by parent entry)', async () => {
    const posted = await postFresh();
    const seen = await withContext(ctxFor(fx.posterId), async (tx: NodePgDatabase) =>
      tx.execute<{ id: string }>(sql`select id from billing.journal_lines where entry_id = ${posted.id}`),
    );
    expect(seen.rows).toHaveLength(2);
  });
});

// --- Scenario 2 ---------------------------------------------------------------------------------------

describe('Scenario: An unbalanced entry is refused at COMMIT by the deferred constraint trigger (#6), even when written line by line', () => {
  it('written line by line as the owner, the unbalanced entry is refused at COMMIT (23514, chk_journal_entry_balanced) and nothing persists; the balanced twin commits', async () => {
    const period = await fx.nextPeriod();
    const unbalanced = await commitLineByLine({
      periodId: period.id,
      entryDate: period.startDate,
      lines: [
        { accountId: fx.accounts.debit, debit: '100.000', credit: '0' },
        { accountId: fx.accounts.credit, debit: '0', credit: '99.999' },
      ],
    });
    expect(unbalanced.error?.code).toBe(CHECK_VIOLATION);
    expect(`${unbalanced.error?.constraint ?? ''} ${unbalanced.error?.message ?? ''}`).toContain(BALANCE_CONSTRAINT);
    const gone = await pool.query(`select 1 from billing.journal_entries where doc_no = $1`, [unbalanced.docNo]);
    expect(gone.rows).toHaveLength(0);

    const balanced = await commitLineByLine({
      periodId: period.id,
      entryDate: period.startDate,
      lines: [
        { accountId: fx.accounts.debit, debit: '100.000', credit: '0' },
        { accountId: fx.accounts.credit, debit: '0', credit: '100.000' },
      ],
    });
    expect(balanced.error).toBeUndefined();
    expect(await getLines(balanced.entryId)).toHaveLength(2);
  });

  it('through a genuine pgeos_app session, the unbalanced entry is refused when the transaction commits (23514)', async () => {
    const period = await fx.nextPeriod();
    const docNo = `JE-POSTJ-${randomUUID().slice(0, 12)}`;
    let refusal: unknown;
    try {
      await withContext(ctxFor(fx.posterId), async (tx: NodePgDatabase) => {
        await tx.execute(
          sql`insert into billing.journal_entries (entity_id, doc_no, entry_date, description, period_id, entry_type, posted_at, posted_by)
              values (${fx.entityId}, ${docNo}, ${period.startDate}, ${'قيد غير متوازن عبر pgeos_app'}, ${period.id}, 'accrual', now(), ${fx.posterId})`,
        );
        await tx.execute(
          sql`insert into billing.journal_lines (entry_id, account_id, debit, credit)
              select id, ${fx.accounts.debit}, 100, 0 from billing.journal_entries where doc_no = ${docNo} and entity_id = ${fx.entityId}`,
        );
      });
    } catch (error) {
      refusal = error;
    }
    expect(findRaisedException(refusal, CHECK_VIOLATION)).toBeDefined();
    const gone = await pool.query(`select 1 from billing.journal_entries where doc_no = $1`, [docNo]);
    expect(gone.rows).toHaveLength(0);
  });

  it('PostJournal with an unbalanced entry is refused by the domain (UnbalancedEntryError) and writes nothing', async () => {
    const period = await fx.nextPeriod();
    const correlationId = nextCorrelationId();
    await expect(
      postJournal(
        ctxFor(fx.posterId),
        {
          entityId: fx.entityId,
          periodId: period.id,
          entryDate: period.startDate,
          entryType: 'accrual',
          description: 'قيد غير متوازن',
          lines: [
            { accountId: fx.accounts.debit, debit: '100.000' },
            { accountId: fx.accounts.credit, credit: '100.001' },
          ],
          correlationId,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(UnbalancedEntryError);
    await assertNoWrite(correlationId);
  });
});

// --- Scenario 3 ---------------------------------------------------------------------------------------

describe('Scenario: UPDATE on a posted entry or its lines is refused for pgeos_app (REVOKE, #7)', () => {
  it('catalog: pgeos_app holds no UPDATE and no TRUNCATE privilege on either table', async () => {
    for (const table of ['billing.journal_entries', 'billing.journal_lines']) {
      for (const privilege of ['UPDATE', 'TRUNCATE']) {
        const result: QueryResult<{ held: boolean }> = await pool.query(`select has_table_privilege('pgeos_app', $1, $2) as held`, [table, privilege]);
        expect(result.rows[0]?.held, `${table} ${privilege}`).toBe(false);
      }
    }
  });

  it('an UPDATE as pgeos_app on the entry and on a line is refused (42501); as the owner it is refused by the immutability trigger (23514) — always rolled back', async () => {
    const posted = await postFresh();
    const lineIdResult: QueryResult<{ id: string }> = await pool.query(`select id from billing.journal_lines where entry_id = $1 limit 1`, [posted.id]);
    const lineId = lineIdResult.rows[0]?.id;
    if (!lineId) throw new Error('expected a line');

    const entryAppError = await appRolledBack(fx.posterId, async (tx) => tx.execute(sql`update billing.journal_entries set description = 'x' where id = ${posted.id}`));
    expect(findRaisedException(entryAppError, INSUFFICIENT_PRIVILEGE)).toBeDefined();
    const lineAppError = await appRolledBack(fx.posterId, async (tx) => tx.execute(sql`update billing.journal_lines set description = 'x' where id = ${lineId}`));
    expect(findRaisedException(lineAppError, INSUFFICIENT_PRIVILEGE)).toBeDefined();

    expect(await ownerRolledBack(`update billing.journal_entries set description = 'x' where id = $1`, [posted.id])).toBe(CHECK_VIOLATION);
    expect(await ownerRolledBack(`update billing.journal_lines set description = 'x' where id = $1`, [lineId])).toBe(CHECK_VIOLATION);
    expect(await ownerRolledBack(`update billing.journal_lines set debit = debit + 1 where id = $1`, [lineId])).toBe(CHECK_VIOLATION);

    const entry = await getEntry(posted.id);
    expect(entry.version).toBe(1); // nothing committed.
  });

  it('catalog: statement-level BEFORE TRUNCATE triggers exist on both tables (no TRUNCATE is ever run, D-183)', async () => {
    for (const table of ['billing.journal_entries', 'billing.journal_lines']) {
      const result: QueryResult<{ n: string }> = await pool.query(
        `select count(*)::text as n from pg_trigger
          where tgrelid = $1::regclass and not tgisinternal and (tgtype & 32) <> 0 and (tgtype & 2) <> 0 and (tgtype & 1) = 0`,
        [table],
      );
      expect(Number(result.rows[0]?.n), table).toBeGreaterThanOrEqual(1);
    }
  });
});

// --- Scenario 4 ---------------------------------------------------------------------------------------

describe('Scenario: DELETE on a posted entry or its lines is refused for pgeos_app (REVOKE, #7)', () => {
  it('catalog: pgeos_app holds no DELETE privilege on either table', async () => {
    for (const table of ['billing.journal_entries', 'billing.journal_lines']) {
      const result: QueryResult<{ held: boolean }> = await pool.query(`select has_table_privilege('pgeos_app', $1, 'DELETE') as held`, [table]);
      expect(result.rows[0]?.held, table).toBe(false);
    }
  });

  it('a DELETE as pgeos_app on the entry and on a line is refused (42501); as the owner (T4, T5) it is refused (23514) — always rolled back, nothing deleted', async () => {
    const posted = await postFresh();
    const lineIdResult: QueryResult<{ id: string }> = await pool.query(`select id from billing.journal_lines where entry_id = $1 limit 1`, [posted.id]);
    const lineId = lineIdResult.rows[0]?.id;
    if (!lineId) throw new Error('expected a line');

    const lineAppError = await appRolledBack(fx.posterId, async (tx) => tx.execute(sql`delete from billing.journal_lines where id = ${lineId}`));
    expect(findRaisedException(lineAppError, INSUFFICIENT_PRIVILEGE)).toBeDefined();
    const entryAppError = await appRolledBack(fx.posterId, async (tx) => tx.execute(sql`delete from billing.journal_entries where id = ${posted.id}`));
    expect(findRaisedException(entryAppError, INSUFFICIENT_PRIVILEGE)).toBeDefined();

    expect(await ownerRolledBack(`delete from billing.journal_lines where id = $1`, [lineId])).toBe(CHECK_VIOLATION);
    expect(await ownerRolledBack(`delete from billing.journal_entries where id = $1`, [posted.id])).toBe(CHECK_VIOLATION);

    expect(await getLines(posted.id)).toHaveLength(2);
    expect((await getEntry(posted.id)).posted_at).not.toBeNull();
  });
});

// --- Scenario 5 ---------------------------------------------------------------------------------------

describe('Scenario: The journal_lines → journal_entries FK no longer cascades on delete — asserted from the catalog (`pg_constraint.confdeltype <> \'c\'`), no DELETE runs on the shared DB (D-183) (#7 · 01:1204)', () => {
  it("the foreign key from journal_lines.entry_id to journal_entries has confdeltype <> 'c'", async () => {
    const result: QueryResult<{ confdeltype: string }> = await pool.query(
      `select confdeltype from pg_constraint
        where conrelid = 'billing.journal_lines'::regclass and contype = 'f' and confrelid = 'billing.journal_entries'::regclass`,
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of result.rows) expect(row.confdeltype).not.toBe('c');
  });

  it('the entry_type / approval / version columns exist, and each is classified in identity.column_classification', async () => {
    const columns: QueryResult<{ column_name: string }> = await pool.query(
      `select column_name from information_schema.columns
        where table_schema = 'billing' and table_name = 'journal_entries' and column_name = any($1::text[])`,
      [['entry_type', 'approved_by', 'approved_at', 'version']],
    );
    expect(columns.rows.map((r) => r.column_name).sort()).toEqual(['approved_at', 'approved_by', 'entry_type', 'version']);
    const classified: QueryResult<{ column_name: string }> = await pool.query(
      `select column_name from identity.column_classification
        where schema_name = 'billing' and table_name = 'journal_entries' and column_name = any($1::text[])`,
      [['entry_type', 'approved_by', 'approved_at', 'version']],
    );
    expect(classified.rows.map((r) => r.column_name).sort()).toEqual(['approved_at', 'approved_by', 'entry_type', 'version']);
  });

  it('the constraint triggers T1/T2 (deferrable initially deferred), the BEFORE row triggers T3/T4/T5 and the unique partial index on reversed_by exist', async () => {
    const deferred = async (table: string): Promise<number> => {
      const r: QueryResult<{ n: string }> = await pool.query(
        `select count(*)::text as n from pg_trigger where tgrelid = $1::regclass and tgconstraint <> 0 and tgdeferrable and tginitdeferred`,
        [table],
      );
      return Number(r.rows[0]?.n);
    };
    expect(await deferred('billing.journal_entries')).toBeGreaterThanOrEqual(1); // T1
    expect(await deferred('billing.journal_lines')).toBeGreaterThanOrEqual(1); // T2

    const beforeRow = async (table: string, eventBit: number): Promise<number> => {
      const r: QueryResult<{ n: string }> = await pool.query(
        `select count(*)::text as n from pg_trigger where tgrelid = $1::regclass and not tgisinternal and (tgtype & 1) <> 0 and (tgtype & 2) <> 0 and (tgtype & $2::int) <> 0`,
        [table, eventBit],
      );
      return Number(r.rows[0]?.n);
    };
    const INSERT_BIT = 4;
    const DELETE_BIT = 8;
    const UPDATE_BIT = 16;
    expect(await beforeRow('billing.journal_lines', INSERT_BIT)).toBeGreaterThanOrEqual(1); // T3
    expect(await beforeRow('billing.journal_lines', UPDATE_BIT)).toBeGreaterThanOrEqual(1); // T3/T5
    expect(await beforeRow('billing.journal_lines', DELETE_BIT)).toBeGreaterThanOrEqual(1); // T5
    expect(await beforeRow('billing.journal_entries', UPDATE_BIT)).toBeGreaterThanOrEqual(1); // T4
    expect(await beforeRow('billing.journal_entries', DELETE_BIT)).toBeGreaterThanOrEqual(1); // T4

    const index: QueryResult<{ indexdef: string }> = await pool.query(
      `select indexdef from pg_indexes where schemaname = 'billing' and tablename = 'journal_entries' and indexdef ilike '%unique%' and indexdef ilike '%reversed_by%'`,
    );
    expect(index.rows.some((r) => /where/i.test(r.indexdef))).toBe(true);
  });

  it('billing.mark_journal_reversed (T6): SECURITY DEFINER, pinned search_path, executable by pgeos_app and not by PUBLIC', async () => {
    const proc: QueryResult<{ secdef: boolean; config: string[] | null; app: boolean; pub: boolean }> = await pool.query(
      `select p.prosecdef as secdef, p.proconfig as config,
              has_function_privilege('pgeos_app', p.oid, 'EXECUTE') as app,
              has_function_privilege('public', p.oid, 'EXECUTE') as pub
         from pg_proc p where p.oid = to_regprocedure('billing.mark_journal_reversed(uuid,uuid,integer)')`,
    );
    const row = proc.rows[0];
    expect(row).toBeDefined();
    expect(row?.secdef).toBe(true);
    expect((row?.config ?? []).some((c) => c.startsWith('search_path='))).toBe(true);
    expect(row?.app).toBe(true);
    expect(row?.pub).toBe(false);
  });

  it('the journal_lines RLS policies are scoped through the parent entry (no internal_only policy remains)', async () => {
    const policies: QueryResult<{ policyname: string; qual: string | null; with_check: string | null }> = await pool.query(
      `select policyname, qual, with_check from pg_policies where schemaname = 'billing' and tablename = 'journal_lines'`,
    );
    expect(policies.rows.length).toBeGreaterThanOrEqual(1);
    for (const policy of policies.rows) {
      expect(`${policy.qual ?? ''} ${policy.with_check ?? ''}`, policy.policyname).toContain('journal_entries');
    }
  });
});

// --- Scenario 6 ---------------------------------------------------------------------------------------

describe('Scenario: A line whose account belongs to another entity is refused (#8)', () => {
  it('the database refuses the line (23514, T3) and PostJournal refuses it (AccountNotInEntityError) writing nothing', async () => {
    const period = await fx.nextPeriod();
    const client = await pool.connect();
    try {
      await client.query('begin');
      const inserted = await client.query<{ id: string }>(
        `insert into billing.journal_entries (entity_id, doc_no, entry_date, description, period_id, entry_type, posted_at, posted_by)
         values ($1, $2, $3, $4, $5, 'accrual', now(), $6) returning id`,
        [fx.entityId, `JE-POSTJ-${randomUUID().slice(0, 12)}`, period.startDate, 'قيد بحساب كيان آخر', period.id, fx.bothId],
      );
      const entryId = inserted.rows[0]?.id;
      if (!entryId) throw new Error('expected an entry id');
      fx.trackEntry(entryId);
      await expect(
        client.query(`insert into billing.journal_lines (entry_id, account_id, debit, credit) values ($1, $2, 100, 0)`, [entryId, fx.accounts.foreign]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }

    const correlationId = nextCorrelationId();
    await expect(
      postJournal(
        ctxFor(fx.bothId),
        {
          entityId: fx.entityId,
          periodId: period.id,
          entryDate: period.startDate,
          entryType: 'accrual',
          description: 'قيد بحساب كيان آخر',
          lines: [
            { accountId: fx.accounts.foreign, debit: AMOUNT },
            { accountId: fx.accounts.credit, credit: AMOUNT },
          ],
          correlationId,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(AccountNotInEntityError);
    await assertNoWrite(correlationId);
  });
});

// --- Scenario 7 ---------------------------------------------------------------------------------------

describe('Scenario: A line on an account with is_postable = false is refused (#8)', () => {
  it('the database refuses the line (23514, T3) and PostJournal refuses it (AccountNotPostableError) writing nothing', async () => {
    const period = await fx.nextPeriod();
    const client = await pool.connect();
    try {
      await client.query('begin');
      const inserted = await client.query<{ id: string }>(
        `insert into billing.journal_entries (entity_id, doc_no, entry_date, description, period_id, entry_type, posted_at, posted_by)
         values ($1, $2, $3, $4, $5, 'accrual', now(), $6) returning id`,
        [fx.entityId, `JE-POSTJ-${randomUUID().slice(0, 12)}`, period.startDate, 'قيد بحساب غير قابل للترحيل', period.id, fx.posterId],
      );
      const entryId = inserted.rows[0]?.id;
      if (!entryId) throw new Error('expected an entry id');
      fx.trackEntry(entryId);
      await expect(
        client.query(`insert into billing.journal_lines (entry_id, account_id, debit, credit) values ($1, $2, 100, 0)`, [entryId, fx.accounts.unpostable]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }

    const correlationId = nextCorrelationId();
    await expect(
      postJournal(
        ctxFor(fx.posterId),
        {
          entityId: fx.entityId,
          periodId: period.id,
          entryDate: period.startDate,
          entryType: 'accrual',
          description: 'قيد بحساب غير قابل للترحيل',
          lines: [
            { accountId: fx.accounts.unpostable, debit: AMOUNT },
            { accountId: fx.accounts.credit, credit: AMOUNT },
          ],
          correlationId,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(AccountNotPostableError);
    await assertNoWrite(correlationId);
  });
});

// --- Scenario 8 ---------------------------------------------------------------------------------------

describe('Scenario: A correction is a reversal or adjustment entry, never an edit (D1 4)', () => {
  it('ReverseJournal writes a mirrored posted "reversing" entry, marks the original reversed_by with version + 1, one outbox row and an audit row', async () => {
    const posted = await postFresh();
    const reversalPeriod = await fx.nextPeriod();
    const correlationId = nextCorrelationId();
    const result = await reverseJournal(
      ctxFor(fx.posterId),
      {
        entryId: posted.id,
        expectedVersion: posted.version,
        periodId: reversalPeriod.id,
        entryDate: reversalPeriod.startDate,
        description: 'عكس قيد — WBS 4.20',
        correlationId,
      },
      deps,
    );
    fx.trackEntry(result.id);

    expect(result.reversedEntryId).toBe(posted.id);
    expect(result.originalVersion).toBe(posted.version + 1);

    const reversing = await getEntry(result.id);
    expect(reversing.entry_type).toBe('reversing');
    expect(reversing.posted_at).not.toBeNull();
    expect(reversing.version).toBe(1);
    expect(reversing.period_id).toBe(reversalPeriod.id);
    expect(reversing.entity_id).toBe(fx.entityId);

    const original = await getEntry(posted.id);
    expect(original.reversed_by).toBe(result.id);
    expect(original.version).toBe(posted.version + 1);

    const originalLines = await getLines(posted.id);
    const reversingLines = await getLines(result.id);
    expect(reversingLines).toHaveLength(originalLines.length);
    for (const line of originalLines) {
      expect(reversingLines.find((r) => r.account_id === line.account_id && r.debit === line.credit && r.credit === line.debit)).toBeDefined();
    }

    const events = await outboxRows(correlationId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: REVERSED_EVENT, aggregate_id: posted.id, aggregate_type: ENTRIES_AGGREGATE });
    expect(await auditCount(correlationId)).toBeGreaterThanOrEqual(1);
  });

  it('reversed_by cannot be written directly: pgeos_app is refused (42501); the owner without the version bump is refused (23514) — rolled back', async () => {
    const posted = await postFresh();
    const other = await postFresh();
    const appError = await appRolledBack(fx.posterId, async (tx) => tx.execute(sql`update billing.journal_entries set reversed_by = ${other.id} where id = ${posted.id}`));
    expect(findRaisedException(appError, INSUFFICIENT_PRIVILEGE)).toBeDefined();
    expect(await ownerRolledBack(`update billing.journal_entries set reversed_by = $2 where id = $1`, [posted.id, other.id])).toBe(CHECK_VIOLATION);
    expect((await getEntry(posted.id)).reversed_by).toBeNull();
  });

  it('AdjustJournal writes a new posted "adjustment" entry, leaves the original untouched, one "adjusted" outbox row', async () => {
    const posted = await postFresh();
    const period = await fx.nextPeriod();
    const correlationId = nextCorrelationId();
    const result = await adjustJournal(
      ctxFor(fx.posterId),
      {
        entityId: fx.entityId,
        periodId: period.id,
        entryDate: period.startDate,
        description: 'قيد تسوية — WBS 4.20',
        lines: [
          { accountId: fx.accounts.debit, debit: '25.500' },
          { accountId: fx.accounts.credit, credit: '25.500' },
        ],
        correlationId,
      },
      deps,
    );
    fx.trackEntry(result.id);

    const adjustment = await getEntry(result.id);
    expect(adjustment.entry_type).toBe('adjustment');
    expect(adjustment.posted_at).not.toBeNull();
    expect(adjustment.version).toBe(1);
    const original = await getEntry(posted.id);
    expect(original.reversed_by).toBeNull();
    expect(original.version).toBe(1);

    const events = await outboxRows(correlationId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: ADJUSTED_EVENT, aggregate_id: result.id, aggregate_type: ENTRIES_AGGREGATE });
    expect(await auditCount(correlationId)).toBe(1);
  });

  it('every entry type is one of A0 §1 row 4 (CHECK): an unknown type is refused (23514)', async () => {
    const period = await fx.nextPeriod();
    expect(ENTRY_TYPES).toHaveLength(7);
    const code = await ownerRolledBack(
      `insert into billing.journal_entries (entity_id, doc_no, entry_date, description, period_id, entry_type, posted_at, posted_by)
       values ($1, $2, $3, 'x', $4, 'invented', now(), $5)`,
      [fx.entityId, `JE-POSTJ-${randomUUID().slice(0, 12)}`, period.startDate, period.id, fx.posterId],
    );
    expect(code).toBe(CHECK_VIOLATION);
  });
  describe('billing.mark_journal_reversed (T6) guards — every refusal is SQLSTATE 23514, called as pgeos_app inside a rolled-back transaction', () => {
    const callMark = (userId: string, originalId: string, reversingId: string, expectedVersion: number): Promise<unknown> =>
      appRolledBack(userId, async (tx) => tx.execute(sql`select billing.mark_journal_reversed(${originalId}::uuid, ${reversingId}::uuid, ${expectedVersion}::int)`));

    const mirrorOf = (): Array<{ accountId: string; debit: string; credit: string }> => [
      { accountId: fx.accounts.credit, debit: AMOUNT, credit: '0' },
      { accountId: fx.accounts.debit, debit: '0', credit: AMOUNT },
    ];

    it('control: with a posted "reversing" entry that mirrors the original, the right version and an in-scope caller, the call succeeds (so the refusals below are the guards, not a missing function)', async () => {
      const original = await postFresh();
      const mirror = await commitLineByLine({ entryType: 'reversing', periodId: original.periodId, entryDate: original.entryDate, lines: mirrorOf() });
      expect(mirror.error).toBeUndefined();
      const outcome = await appRolledBack(fx.posterId, async (tx) => {
        await tx.execute(sql`select billing.mark_journal_reversed(${original.id}::uuid, ${mirror.entryId}::uuid, ${original.version}::int)`);
        const after = await tx.execute<{ reversed_by: string; version: number }>(sql`select reversed_by::text as reversed_by, version from billing.journal_entries where id = ${original.id}`);
        expect(after.rows[0]).toMatchObject({ reversed_by: mirror.entryId, version: original.version + 1 });
      });
      expect(outcome).toBeUndefined();
      expect((await getEntry(original.id)).reversed_by).toBeNull(); // rolled back.
    });

    it('the reversing entry is an "adjustment" entry, not "reversing" -> 23514', async () => {
      const original = await postFresh();
      const period = await fx.nextPeriod();
      const adjustment = await adjustJournal(
        ctxFor(fx.posterId),
        { entityId: fx.entityId, periodId: period.id, entryDate: period.startDate, description: 'تسوية لاختبار T6', lines: mirrorOf().map((l) => ({ accountId: l.accountId, ...(l.debit !== '0' ? { debit: l.debit } : { credit: l.credit }) })), correlationId: nextCorrelationId() },
        deps,
      );
      fx.trackEntry(adjustment.id);
      expect(findRaisedException(await callMark(fx.posterId, original.id, adjustment.id, original.version), CHECK_VIOLATION)).toBeDefined();
    });

    it('the reversing entry\'s lines do not mirror the original (balanced but different accounts) -> 23514', async () => {
      const original = await postFresh();
      const notMirror = await commitLineByLine({
        entryType: 'reversing',
        periodId: original.periodId,
        entryDate: original.entryDate,
        lines: [
          { accountId: fx.accounts.credit, debit: AMOUNT, credit: '0' },
          { accountId: fx.accounts.revenue, debit: '0', credit: AMOUNT },
        ],
      });
      expect(notMirror.error).toBeUndefined();
      expect(findRaisedException(await callMark(fx.posterId, original.id, notMirror.entryId, original.version), CHECK_VIOLATION)).toBeDefined();
    });

    it('a stale expected version -> 23514', async () => {
      const original = await postFresh();
      const mirror = await commitLineByLine({ entryType: 'reversing', periodId: original.periodId, entryDate: original.entryDate, lines: mirrorOf() });
      expect(mirror.error).toBeUndefined();
      expect(findRaisedException(await callMark(fx.posterId, original.id, mirror.entryId, STALE_VERSION), CHECK_VIOLATION)).toBeDefined();
    });

    it('a caller scoped only to another entity -> 23514 (design default: every T6 guard, including the allowed_entities() check, raises the same SQLSTATE and names only the row\'s own values, so the refusal reveals nothing about the entry)', async () => {
      const original = await postFresh();
      const mirror = await commitLineByLine({ entryType: 'reversing', periodId: original.periodId, entryDate: original.entryDate, lines: mirrorOf() });
      expect(mirror.error).toBeUndefined();
      expect(findRaisedException(await callMark(fx.outsiderId, original.id, mirror.entryId, original.version), CHECK_VIOLATION)).toBeDefined();
    });
  });
});

// --- Scenario 9 ---------------------------------------------------------------------------------------

describe('Scenario: A manual journal to a revenue account is refused; other manual journals need CFO approval (OD-15)', () => {
  it('the database: a manual entry without approved_by, an approved_by without approved_at, and an approved manual entry touching a revenue account are each refused (23514)', async () => {
    const period = await fx.nextPeriod();
    const insertEntry = `insert into billing.journal_entries (entity_id, doc_no, entry_date, description, period_id, entry_type, posted_at, posted_by, approved_by, approved_at)
                         values ($1, $2, $3, 'x', $4, 'manual', now(), $5, $6, $7)`;
    const base = (): unknown[] => [fx.entityId, `JE-POSTJ-${randomUUID().slice(0, 12)}`, period.startDate, period.id, fx.posterId];

    expect(await ownerRolledBack(insertEntry, [...base(), null, null])).toBe(CHECK_VIOLATION); // manual, no approval
    expect(await ownerRolledBack(insertEntry, [...base(), fx.bothId, null])).toBe(CHECK_VIOLATION); // approved_by without approved_at
    expect(await ownerRolledBack(insertEntry, [...base(), null, new Date('2026-09-29T00:00:00.000Z')])).toBe(CHECK_VIOLATION); // approved_at without approved_by

    const client = await pool.connect();
    try {
      await client.query('begin');
      const inserted = await client.query<{ id: string }>(`${insertEntry} returning id`, [...base(), fx.bothId, new Date('2026-09-29T00:00:00.000Z')]);
      const entryId = inserted.rows[0]?.id;
      if (!entryId) throw new Error('expected an entry id');
      fx.trackEntry(entryId);
      await expect(
        client.query(`insert into billing.journal_lines (entry_id, account_id, debit, credit) values ($1, $2, 0, 100)`, [entryId, fx.accounts.revenue]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });
});

// --- Scenario 10 --------------------------------------------------------------------------------------

describe('Scenario: Posting into a closed or locked period is refused (4.19 carried)', () => {
  it('PostJournal into a closed period and into a locked period is refused (PeriodNotOpenError), nothing written', async () => {
    const closed = await fx.nextPeriod();
    await fx.setPeriodStatus(closed.id, 'closed');
    const locked = await fx.nextPeriod();
    await fx.setPeriodStatus(locked.id, 'locked');

    for (const period of [closed, locked]) {
      const correlationId = nextCorrelationId();
      await expect(
        postJournal(
          ctxFor(fx.posterId),
          {
            entityId: fx.entityId,
            periodId: period.id,
            entryDate: period.startDate,
            entryType: 'accrual',
            description: 'ترحيل في فترة مقفلة',
            lines: balancedLines(),
            correlationId,
          },
          deps,
        ),
      ).rejects.toBeInstanceOf(PeriodNotOpenError);
      await assertNoWrite(correlationId);
    }
  });
});

// --- Scenario 12 --------------------------------------------------------------------------------------

describe('Scenario: Stale version is rejected; idempotent replay returns the first result', () => {
  it('a stale expectedVersion on ReverseJournal is refused (StaleVersionError), nothing written, original untouched', async () => {
    const posted = await postFresh();
    const period = await fx.nextPeriod();
    const correlationId = nextCorrelationId();
    await expect(
      reverseJournal(
        ctxFor(fx.posterId),
        { entryId: posted.id, expectedVersion: STALE_VERSION, periodId: period.id, entryDate: period.startDate, description: 'عكس قديم', correlationId },
        deps,
      ),
    ).rejects.toBeInstanceOf(StaleVersionError);
    await assertNoWrite(correlationId);
    const original = await getEntry(posted.id);
    expect(original.reversed_by).toBeNull();
    expect(original.version).toBe(1);
  });

  it('the same Idempotency-Key and body twice: the second PostJournal returns the identical result; exactly one entry and one outbox row exist', async () => {
    const period = await fx.nextPeriod();
    const correlationId = nextCorrelationId();
    const description = `قيد إعادة تشغيل ${randomUUID()}`;
    const body = {
      entityId: fx.entityId,
      periodId: period.id,
      entryDate: period.startDate,
      entryType: 'accrual' as const,
      description,
      lines: balancedLines(),
      correlationId,
    };
    const idem = idemFor('post-journal', randomUUID(), body);

    const first = await postJournal(ctxFor(fx.posterId), { ...body, idem }, deps);
    fx.trackEntry(first.id);
    const second = await postJournal(ctxFor(fx.posterId), { ...body, idem }, deps);
    expect(second).toEqual(first);

    const count: QueryResult<{ n: string }> = await pool.query(`select count(*)::text as n from billing.journal_entries where entity_id = $1 and description = $2`, [fx.entityId, description]);
    expect(Number(count.rows[0]?.n)).toBe(1);
    expect(await outboxRows(correlationId, POSTED_EVENT)).toHaveLength(1);
  });
});

// --- Scenario 13 --------------------------------------------------------------------------------------

describe("Scenario: RLS — a caller scoped to another entity cannot post, see or reverse this entity's entries", () => {
  it('zero entries and zero lines visible; a direct INSERT is refused by RLS (42501); PostJournal -> EntityNotInScopeError; ReverseJournal -> JournalEntryNotFoundError', async () => {
    const posted = await postFresh();

    const entriesSeen = await withContext(ctxFor(fx.outsiderId), async (tx: NodePgDatabase) =>
      tx.execute<{ id: string }>(sql`select id from billing.journal_entries where entity_id = ${fx.entityId}`),
    );
    expect(entriesSeen.rows).toHaveLength(0);
    const linesSeen = await withContext(ctxFor(fx.outsiderId), async (tx: NodePgDatabase) =>
      tx.execute<{ id: string }>(sql`select id from billing.journal_lines where entry_id = ${posted.id}`),
    );
    expect(linesSeen.rows).toHaveLength(0);

    const insertError = await appRolledBack(fx.outsiderId, async (tx) =>
      tx.execute(
        sql`insert into billing.journal_entries (entity_id, doc_no, entry_date, description, period_id, entry_type, posted_at, posted_by)
            values (${fx.entityId}, ${`JE-POSTJ-${randomUUID().slice(0, 12)}`}, ${posted.entryDate}, 'x', ${posted.periodId}, 'accrual', now(), ${fx.outsiderId})`,
      ),
    );
    expect(findRaisedException(insertError, INSUFFICIENT_PRIVILEGE)).toBeDefined();

    const postCorrelation = nextCorrelationId();
    await expect(
      postJournal(
        ctxFor(fx.outsiderId),
        {
          entityId: fx.entityId,
          periodId: posted.periodId,
          entryDate: posted.entryDate,
          entryType: 'accrual',
          description: 'ترحيل من كيان آخر',
          lines: balancedLines(),
          correlationId: postCorrelation,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(EntityNotInScopeError);
    await assertNoWrite(postCorrelation);

    const reverseCorrelation = nextCorrelationId();
    await expect(
      reverseJournal(
        ctxFor(fx.outsiderId),
        { entryId: posted.id, expectedVersion: posted.version, periodId: posted.periodId, entryDate: posted.entryDate, description: 'عكس من كيان آخر', correlationId: reverseCorrelation },
        deps,
      ),
    ).rejects.toBeInstanceOf(JournalEntryNotFoundError);
    await assertNoWrite(reverseCorrelation);
    expect((await getEntry(posted.id)).reversed_by).toBeNull();
  });
});

// --- Scenario: CFO role gate (doc 38 4.20 Owner CFO) ---------------------------------------------------
// Order asserted: missing-actor check, then (inside the transaction, after the entity-scope / entry
// lookup) the CFO role check via platform.my_roles(), and BEFORE any write: no journal, outbox or audit row.

describe('Scenario: A caller without the CFO role cannot post, reverse or adjust (doc 38 4.20 Owner CFO; SCR-BILLING-JOURNAL-PERM-01 carries the finer codes)', () => {
  it('PostJournal by an in-scope non-CFO actor -> RoleRequiredError, no journal/outbox/audit row', async () => {
    const period = await fx.nextPeriod();
    const correlationId = nextCorrelationId();
    await expect(
      postJournal(
        ctxFor(fx.plainId),
        { entityId: fx.entityId, periodId: period.id, entryDate: period.startDate, entryType: 'accrual', description: 'ترحيل بلا دور المدير المالي', lines: balancedLines(), correlationId },
        deps,
      ),
    ).rejects.toBeInstanceOf(RoleRequiredError);
    await assertNoWrite(correlationId);
  });

  it('ReverseJournal by an in-scope non-CFO actor -> RoleRequiredError, no new row, original untouched', async () => {
    const posted = await postFresh();
    const period = await fx.nextPeriod();
    const correlationId = nextCorrelationId();
    await expect(
      reverseJournal(
        ctxFor(fx.plainId),
        { entryId: posted.id, expectedVersion: posted.version, periodId: period.id, entryDate: period.startDate, description: 'عكس بلا دور المدير المالي', correlationId },
        deps,
      ),
    ).rejects.toBeInstanceOf(RoleRequiredError);
    await assertNoWrite(correlationId);
    const original = await getEntry(posted.id);
    expect(original.reversed_by).toBeNull();
    expect(original.version).toBe(posted.version);
  });

  it('AdjustJournal by an in-scope non-CFO actor -> RoleRequiredError, no journal/outbox/audit row', async () => {
    const period = await fx.nextPeriod();
    const correlationId = nextCorrelationId();
    await expect(
      adjustJournal(
        ctxFor(fx.plainId),
        { entityId: fx.entityId, periodId: period.id, entryDate: period.startDate, description: 'تسوية بلا دور المدير المالي', lines: balancedLines(), correlationId },
        deps,
      ),
    ).rejects.toBeInstanceOf(RoleRequiredError);
    await assertNoWrite(correlationId);
  });
});

// --- Scenario 14 --------------------------------------------------------------------------------------

describe('Scenario: Reversal of an entry in a closed period succeeds (T7)', () => {
  it('the original sits in a period that has since been closed; the reversal into an open period succeeds and marks the original reversed', async () => {
    const posted = await postFresh();
    await fx.setPeriodStatus(posted.periodId, 'closed');
    const openPeriod = await fx.nextPeriod();
    const correlationId = nextCorrelationId();

    const result = await reverseJournal(
      ctxFor(fx.posterId),
      { entryId: posted.id, expectedVersion: posted.version, periodId: openPeriod.id, entryDate: openPeriod.startDate, description: 'عكس قيد فترة مقفلة', correlationId },
      deps,
    );
    fx.trackEntry(result.id);

    const original = await getEntry(posted.id);
    expect(original.reversed_by).toBe(result.id);
    expect(original.period_id).toBe(posted.periodId);
    expect((await getEntry(result.id)).period_id).toBe(openPeriod.id);
    expect(await outboxRows(correlationId, REVERSED_EVENT)).toHaveLength(1);
  });
});

// --- Scenario 15 --------------------------------------------------------------------------------------

describe('Scenario: A second reversal of the same entry is refused', () => {
  it('AlreadyReversedError with the entry\'s now-current version; nothing written; the first reversal stays the only one', async () => {
    const posted = await postFresh();
    const first = await fx.nextPeriod();
    const reversal = await reverseJournal(
      ctxFor(fx.posterId),
      { entryId: posted.id, expectedVersion: posted.version, periodId: first.id, entryDate: first.startDate, description: 'عكس أول', correlationId: nextCorrelationId() },
      deps,
    );
    fx.trackEntry(reversal.id);

    const secondPeriod = await fx.nextPeriod();
    const correlationId = nextCorrelationId();
    await expect(
      reverseJournal(
        ctxFor(fx.posterId),
        { entryId: posted.id, expectedVersion: reversal.originalVersion, periodId: secondPeriod.id, entryDate: secondPeriod.startDate, description: 'عكس ثانٍ', correlationId },
        deps,
      ),
    ).rejects.toBeInstanceOf(AlreadyReversedError);
    await assertNoWrite(correlationId);
    expect((await getEntry(posted.id)).reversed_by).toBe(reversal.id);
  });
});

// --- Scenario 16 --------------------------------------------------------------------------------------

describe('Scenario: An entry with zero lines is refused at commit', () => {
  it('the owner inserting an entry and no line is refused at COMMIT (23514, chk_journal_entry_balanced); PostJournal with zero lines or one line -> InsufficientLinesError', async () => {
    const period = await fx.nextPeriod();
    const result = await commitLineByLine({ periodId: period.id, entryDate: period.startDate, lines: [] });
    expect(result.error?.code).toBe(CHECK_VIOLATION);
    expect(`${result.error?.constraint ?? ''} ${result.error?.message ?? ''}`).toContain(BALANCE_CONSTRAINT);
    expect((await pool.query(`select 1 from billing.journal_entries where doc_no = $1`, [result.docNo])).rows).toHaveLength(0);

    for (const lines of [[], [{ accountId: fx.accounts.debit, debit: AMOUNT }]]) {
      const correlationId = nextCorrelationId();
      await expect(
        postJournal(
          ctxFor(fx.posterId),
          { entityId: fx.entityId, periodId: period.id, entryDate: period.startDate, entryType: 'accrual', description: 'قيد بلا أسطر كافية', lines, correlationId },
          deps,
        ),
      ).rejects.toBeInstanceOf(InsufficientLinesError);
      await assertNoWrite(correlationId);
    }
  });
});

// --- Scenario 17 --------------------------------------------------------------------------------------

describe('Scenario: Part 1 refuses every manual journal — revenue with a typed error, otherwise approval required', () => {
  it('manual + revenue line -> ManualRevenueJournalRefusedError; manual without revenue -> ManualJournalApprovalRequiredError; nothing written', async () => {
    const period = await fx.nextPeriod();
    const revenueCorrelation = nextCorrelationId();
    await expect(
      postJournal(
        ctxFor(fx.posterId),
        {
          entityId: fx.entityId,
          periodId: period.id,
          entryDate: period.startDate,
          entryType: 'manual',
          description: 'قيد يدوي على إيراد',
          lines: [
            { accountId: fx.accounts.debit, debit: AMOUNT },
            { accountId: fx.accounts.revenue, credit: AMOUNT },
          ],
          correlationId: revenueCorrelation,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ManualRevenueJournalRefusedError);
    await assertNoWrite(revenueCorrelation);

    const approvalCorrelation = nextCorrelationId();
    await expect(
      postJournal(
        ctxFor(fx.posterId),
        {
          entityId: fx.entityId,
          periodId: period.id,
          entryDate: period.startDate,
          entryType: 'manual',
          description: 'قيد يدوي يحتاج موافقة',
          lines: balancedLines(),
          correlationId: approvalCorrelation,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ManualJournalApprovalRequiredError);
    await assertNoWrite(approvalCorrelation);
  });
});

// --- Scenario 18 --------------------------------------------------------------------------------------

describe('Scenario: Other-entity lines are invisible', () => {
  it('a caller scoped only to the second entity sees zero lines of the pilot entry; a pilot-scoped caller sees them', async () => {
    const posted = await postFresh();
    const outsiderView = await withContext(ctxFor(fx.outsiderId), async (tx: NodePgDatabase) =>
      tx.execute<{ id: string }>(sql`select id from billing.journal_lines where entry_id = ${posted.id}`),
    );
    expect(outsiderView.rows).toHaveLength(0);
    const posterView = await withContext(ctxFor(fx.posterId), async (tx: NodePgDatabase) =>
      tx.execute<{ id: string }>(sql`select id from billing.journal_lines where entry_id = ${posted.id}`),
    );
    expect(posterView.rows).toHaveLength(2);
  });
});

// G2 runs LAST (feature: 'after the suite'): every entry this file posted or committed exists by now.
// --- Scenario 11 --------------------------------------------------------------------------------------

describe('Scenario: G2 billing.verify_journal_balance() returns zero rows after the suite', () => {
  it('billing.verify_journal_balance() returns zero rows (every entry this file committed balances)', async () => {
    await postFresh();
    const rows = await pool.query(`select * from billing.verify_journal_balance()`);
    expect(rows.rows).toHaveLength(0);
  });
});
