// modules/billing/tests/accounting-periods/invariants.property.integration.test.ts — WBS 4.19 (lane 2).
//
// 4.19 pre-build review, directive D5 (verbatim, restated as the brief's own property): "for any
// generated set of periods and entry dates, the DB accepts a posting <=> the covering period of
// the same entity is `open`." This file proves the refusal/acceptance is genuinely DB-enforced
// over a whole GENERATED SET of periods per entity (not just one), across both fixture entities,
// with every fixture period reached ONLY through its own legal open->closed->locked edges (4.19
// pre-build review finding 3) — never a direct non-open INSERT, which D4 itself refuses (23514).
//
// Isolation (4.19 pre-build review finding 1): this file picks its OWN synthetic fiscal year,
// strictly after any synthetic year a previous integration file in this run already used, so its
// fixtures can never collide with (or be hidden behind) another file's residue.
//
// Property test — real database (database/migrations/0040_2_accounting-periods.sql, applied; GREEN
// against pgeos_lane2). Every period + journal entry this file inserts is deleted at the end of its
// OWN fast-check run (try/finally) — every ACCEPTED posting here lands in a period that is either
// uncovered or "open" (never closed/locked — those cases are always REFUSED before any row
// exists), so nothing this file creates is ever protected/undeletable. afterAll (close review
// round 1 finding #6) force-deletes this file's own fiscal years (and, defensively, any period
// still referencing one) in one admin transaction under `session_replication_role = replica` —
// never left as residue, so the synthetic-year picker never runs out of room across repeated runs
// (a real risk once Stryker starts running this file once per mutant).

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ACCOUNTING_PERIOD_STATUSES } from '@pg-eos/contracts/billing/accounting-periods';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

// D4/D5's own CHECK/constraint-trigger violation SQLSTATE (../accounting-periods.test.ts pins the
// same code for "rejected by the database").
const CHECK_VIOLATION = '23514';
const NAME_AR = 'قيد اختبار الخاصية — WBS 4.19';

// --- 4.19 pre-build review finding 1: this file's own synthetic fiscal year ----------------------
// Never 2026, never current_date — a fresh, strictly-increasing synthetic year per integration
// file/run, so residue from a PREVIOUS run (or from ../accounting-periods.test.ts /
// ../handlers.test.ts in the SAME run) can never overlap this file's own fiscal-year window.
const SYNTHETIC_YEAR_FLOOR = 1899;
const SYNTHETIC_YEAR_CUTOFF = '1950-01-01';
const WINDOW_DAYS = 120; // the tiled window every generated period set lives inside.
const MAX_PERIODS_PER_ENTITY = 4;
const PROPERTY_RUNS = 15; // kept modest: up to 8 period fixtures (4 PST + 4 PCC) per run.

let entityId: string;
let outsiderEntityId: string;
let fiscalYearId: string;
let outsiderFiscalYearId: string;
let fyStart: string;

const insertedFiscalYearIds: string[] = [];
// 0041 (WBS 4.20): an accepted entry needs balanced lines on a postable account of ITS entity.
const glAccountByEntity = new Map<string, string>();
const insertedGlAccountIds: string[] = [];

async function insertGlAccountFor(forEntityId: string): Promise<string> {
  const code = `9-${randomUUID().replace(/\D/g, '').padEnd(14, '0').slice(0, 2)}-${randomUUID().replace(/\D/g, '').padEnd(14, '0').slice(0, 3)}-${randomUUID().replace(/\D/g, '').padEnd(14, '0').slice(0, 3)}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.gl_accounts (entity_id, code, name_ar, account_type) values ($1, $2, $3, 'expense') returning id`,
    [forEntityId, code, NAME_AR],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture billing.gl_accounts insert returned no id');
  insertedGlAccountIds.push(row.id);
  glAccountByEntity.set(forEntityId, row.id);
  return row.id;
}

/** Deletes this file's OWN accepted entry and its lines in one admin transaction under
 *  session_replication_role = replica (4.19 precedent) so balance-at-commit / the lines FK do not
 *  fire. Must run per generated case (not only in afterAll): accepted entries may carry period_id,
 *  and a period with a referencing entry cannot be deleted, which would leave overlapping periods
 *  for the next generated case (ex_accounting_periods_no_overlap 23P01). */
async function deleteOwnEntry(entryId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local session_replication_role = replica`);
    await client.query(`delete from billing.journal_lines where entry_id = $1`, [entryId]);
    await client.query(`delete from billing.journal_entries where id = $1`, [entryId]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function freshDocNo(): string {
  return `JE-PROP-${randomUUID().slice(0, 8)}`;
}

async function pickSyntheticYear(entityIds: readonly string[]): Promise<number> {
  const result: QueryResult<{ year: number }> = await pool.query(
    `select coalesce(max(extract(year from end_date))::int, $2) + 1 as year
       from billing.fiscal_years where entity_id = any($1::uuid[]) and end_date < $3::date`,
    [entityIds, SYNTHETIC_YEAR_FLOOR, SYNTHETIC_YEAR_CUTOFF],
  );
  const year = result.rows[0]?.year;
  if (year === undefined) throw new Error('pickSyntheticYear: query returned no row');
  return year;
}

async function insertFiscalYearFixture(forEntityId: string, startDate: string, endDate: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.fiscal_years (entity_id, start_date, end_date) values ($1, $2, $3) returning id`,
    [forEntityId, startDate, endDate],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('fixture billing.fiscal_years insert returned no id');
  insertedFiscalYearIds.push(id);
  return id;
}

/** D4: INSERT is legal ONLY at status 'open' — every fixture period is created open, then driven
 *  to its target status through the ONLY legal edges (open->closed[->locked]), never a direct
 *  non-open INSERT. */
async function insertOpenPeriodAdmin(input: { forEntityId: string; forFiscalYearId: string; startDate: string; endDate: string }): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.accounting_periods (entity_id, fiscal_year_id, start_date, end_date)
     values ($1, $2, $3, $4) returning id`,
    [input.forEntityId, input.forFiscalYearId, input.startDate, input.endDate],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('fixture billing.accounting_periods insert returned no id');
  return id;
}

/** Close review round 1 (VERIFY) finding #1: the 0040 guard now also refuses `new.version <
 *  old.version` and any status change whose `new.version <> old.version + 1` — every legal
 *  open->closed[->locked] admin-pool advance bumps version by exactly 1 per edge. */
async function reachStatusViaAdmin(periodId: string, target: (typeof ACCOUNTING_PERIOD_STATUSES)[number]): Promise<void> {
  if (target === 'open') return;
  await pool.query(`update billing.accounting_periods set status = 'closed', version = version + 1 where id = $1`, [periodId]);
  if (target === 'locked') {
    await pool.query(`update billing.accounting_periods set status = 'locked', version = version + 1 where id = $1`, [periodId]);
  }
}

interface TiledPeriod {
  readonly id: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly status: (typeof ACCOUNTING_PERIOD_STATUSES)[number];
}

/** Splits [0, WINDOW_DAYS-1] into `n` CONSECUTIVE, NON-OVERLAPPING blocks (no gaps) — one period
 *  per block, each driven open->[closed[->locked]] to its own generated `statuses[i]` (4.19
 *  pre-build review finding 3: "Fixtures insert every period 'open', then UPDATE along legal
 *  edges"). */
async function buildTiledPeriods(
  forEntityId: string,
  forFiscalYearId: string,
  n: number,
  statuses: ReadonlyArray<(typeof ACCOUNTING_PERIOD_STATUSES)[number]>,
): Promise<TiledPeriod[]> {
  const blockLength = Math.floor(WINDOW_DAYS / n);
  const periods: TiledPeriod[] = [];
  for (let i = 0; i < n; i += 1) {
    const startOffset = i * blockLength;
    const endOffset = i === n - 1 ? WINDOW_DAYS - 1 : (i + 1) * blockLength - 1;
    const id = await insertOpenPeriodAdmin({
      forEntityId,
      forFiscalYearId,
      startDate: addDays(fyStart, startOffset),
      endDate: addDays(fyStart, endOffset),
    });
    const status = statuses[i] ?? 'open';
    await reachStatusViaAdmin(id, status);
    periods.push({ id, startOffset, endOffset, status });
  }
  return periods;
}

/** Attempts the insert directly (bypassing the application layer entirely — same discipline as
 *  ../accounting-periods.test.ts's own "rejected by the database" scenarios). */
async function dbAcceptsPosting(
  forEntityId: string,
  entryDate: string,
  periodId: string | null,
): Promise<{ accepted: boolean; insertedId?: string }> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result: QueryResult<{ id: string }> = await client.query(
      `insert into billing.journal_entries (entity_id, doc_no, entry_date, description, period_id, entry_type)
       values ($1, $2, $3, $4, $5, 'accrual') returning id`,
      [forEntityId, freshDocNo(), entryDate, NAME_AR, periodId],
    );
    const id = result.rows[0]?.id;
    const accountId = glAccountByEntity.get(forEntityId);
    if (id === undefined || accountId === undefined) throw new Error('fixture journal entry / gl account missing');
    await client.query(
      `insert into billing.journal_lines (entry_id, account_id, debit, credit) values ($1, $2, 100.000, 0), ($1, $2, 0, 100.000)`,
      [id, accountId],
    );
    await client.query('commit');
    return { accepted: true, insertedId: id };
  } catch (error) {
    await client.query('rollback');
    const pgError = error as { code?: string };
    if (pgError.code === CHECK_VIOLATION) return { accepted: false };
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupPeriods(periods: readonly TiledPeriod[]): Promise<void> {
  for (const period of periods) {
    // Best-effort: every accepted posting above was already deleted by its own caller before this
    // runs, so no residue journal entry can still reference these periods — the delete should
    // always succeed, but stays best-effort per the same discipline as
    // ../dimensions/invariants.property.integration.test.ts's own afterAll.
    try {
      await pool.query(`delete from billing.accounting_periods where id = $1`, [period.id]);
    } catch {
      // best-effort only.
    }
  }
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, ['PST']);
  const entityRow = entityResult.rows[0];
  if (!entityRow) throw new Error(`platform.entities row not found for code 'PST'`);
  entityId = entityRow.id;

  const outsiderEntityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, ['PCC']);
  const outsiderEntityRow = outsiderEntityResult.rows[0];
  if (!outsiderEntityRow) throw new Error(`platform.entities row not found for code 'PCC'`);
  outsiderEntityId = outsiderEntityRow.id;

  const year = await pickSyntheticYear([entityId, outsiderEntityId]);
  fyStart = `${year}-01-01`;
  const fyEnd = `${year}-12-31`;

  fiscalYearId = await insertFiscalYearFixture(entityId, fyStart, fyEnd);
  outsiderFiscalYearId = await insertFiscalYearFixture(outsiderEntityId, fyStart, fyEnd);
  await insertGlAccountFor(entityId);
  await insertGlAccountFor(outsiderEntityId);
});

afterAll(async () => {
  // Close review round 1 (VERIFY) finding #6: residue exhausts the synthetic years below 1950 (the
  // picker moves the year forward every run; Stryker runs this file once PER MUTANT). Every row
  // this file itself recorded is force-deleted in ONE admin transaction, `session_replication_role
  // = replica` (bypasses the closed/locked-posting and immutable-column triggers — safe here
  // because these are this file's OWN rows, never another file's or another lane's) — never the
  // best-effort "leave it as residue" discipline the OLDER design used. Never platform.outbox or
  // platform.audit_log (append-only ledgers, D-183) — nothing here writes to either.
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local session_replication_role = replica`);
    if (insertedGlAccountIds.length > 0) {
      await client.query(`delete from billing.gl_accounts where id = any($1::uuid[])`, [insertedGlAccountIds]);
    }
    if (insertedFiscalYearIds.length > 0) {
      // Defense in depth: every fast-check run already deletes its own periods in a `finally`
      // (cleanupPeriods) regardless of pass/fail, so none should ever leak past a single run — this
      // sweep only guards against that invariant ever being violated, before the fiscal years.
      await client.query(`delete from billing.accounting_periods where fiscal_year_id = any($1::uuid[])`, [insertedFiscalYearIds]);
      await client.query(`delete from billing.fiscal_years where id = any($1::uuid[])`, [insertedFiscalYearIds]);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error; // a genuine cleanup failure must be visible, never silently swallowed.
  } finally {
    client.release();
    await pool.end();
  }
});

describe('the DB accepts a posting <=> the covering period of the same entity is "open" (ADR-0004 D1 5, 4.19 pre-build review D5)', () => {
  it('for any generated SET of periods per entity, any generated status, and any generated (entity, date, period_id), DB acceptance matches coverage x open-ness', async () => {
    const statusArb = fc.constantFrom(...ACCOUNTING_PERIOD_STATUSES);
    const countArb = fc.integer({ min: 1, max: MAX_PERIODS_PER_ENTITY });
    const statusesArb = fc.array(statusArb, { minLength: MAX_PERIODS_PER_ENTITY, maxLength: MAX_PERIODS_PER_ENTITY });
    const entityChoiceArb = fc.constantFrom<'PST' | 'PCC'>('PST', 'PCC');
    const dateOffsetArb = fc.integer({ min: -10, max: WINDOW_DAYS + 10 });
    const useCoveringIdArb = fc.boolean();

    await fc.assert(
      fc.asyncProperty(
        countArb,
        statusesArb,
        countArb,
        statusesArb,
        entityChoiceArb,
        dateOffsetArb,
        useCoveringIdArb,
        async (nPst, pstStatusesFull, nPcc, pccStatusesFull, entityChoice, dateOffset, useCoveringId) => {
          let pstPeriods: TiledPeriod[] = [];
          let pccPeriods: TiledPeriod[] = [];
          try {
            pstPeriods = await buildTiledPeriods(entityId, fiscalYearId, nPst, pstStatusesFull.slice(0, nPst));
            pccPeriods = await buildTiledPeriods(outsiderEntityId, outsiderFiscalYearId, nPcc, pccStatusesFull.slice(0, nPcc));

            const targetEntityId = entityChoice === 'PST' ? entityId : outsiderEntityId;
            const periods = entityChoice === 'PST' ? pstPeriods : pccPeriods;
            const covering = periods.find((p) => dateOffset >= p.startOffset && dateOffset <= p.endOffset);
            const entryDate = addDays(fyStart, dateOffset);
            const periodIdParam = covering && useCoveringId ? covering.id : null;
            const expectedAccept = !covering || covering.status === 'open';

            const outcome = await dbAcceptsPosting(targetEntityId, entryDate, periodIdParam);
            try {
              expect(outcome.accepted).toBe(expectedAccept);
            } finally {
              if (outcome.insertedId) {
                await deleteOwnEntry(outcome.insertedId);
              }
            }
          } finally {
            await cleanupPeriods(pstPeriods);
            await cleanupPeriods(pccPeriods);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  // 4.19 pre-build review finding 3 ("Same for the it.each block"): every status value
  // unconditionally exercised via a single-period tiling (n=1), open->[closed[->locked]] only.
  it.each(ACCOUNTING_PERIOD_STATUSES)(
    'status = %s, entry date always INSIDE the (single, whole-window) period: accepted iff status is "open"',
    async (status) => {
      let periods: TiledPeriod[] = [];
      try {
        periods = await buildTiledPeriods(entityId, fiscalYearId, 1, [status]);
        const entryDate = addDays(fyStart, Math.floor(WINDOW_DAYS / 2));
        const outcome = await dbAcceptsPosting(entityId, entryDate, null);
        try {
          expect(outcome.accepted).toBe(status === 'open');
        } finally {
          if (outcome.insertedId) {
            await deleteOwnEntry(outcome.insertedId);
          }
        }
      } finally {
        await cleanupPeriods(periods);
      }
    },
  );
});
