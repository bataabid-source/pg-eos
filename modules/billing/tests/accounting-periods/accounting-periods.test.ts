// modules/billing/tests/accounting-periods/accounting-periods.test.ts — WBS 4.19 (lane 2).
//
// Integration tests against the real database (pgeos_lane2 — MUST be run with
// `PGDATABASE=pgeos_lane2` exported in the SAME shell command; the session default `pgeos` does
// not carry this lane's fixtures and its own tests/dimensions baseline) — admin pool (PGUSER,
// bypasses RLS) for fixture setup/teardown and every "the database itself rejects/accepts this"
// constraint proof, plus `withContext` as a genuine pgeos_app session for every RLS/role/grant
// scenario. One `describe` per ./accounting-periods.feature Scenario, title matching EXACTLY
// (precedent: modules/billing/tests/dimensions/line-dimensions.test.ts).
//
// 4.19 pre-build review (2026-09-28) final design directives D1-D5, D8, D9 replace this file's own
// earlier defaults where they differ; every one is cited inline by its own id below, never as
// "brief item n" or "OD-12" (4.19 pre-build review finding 14 — OD-12 stays only for the
// ADR-0004-level business rule itself, e.g. in Scenario titles copied from the .feature file).
//
// Isolation (4.19 pre-build review finding 1): this file picks its OWN synthetic fiscal year
// (never 2026, never current_date), strictly after any synthetic year a previous integration file
// in the same run already used — so this file's own fixtures can never collide with, or be hidden
// behind, another file's, and can never break the pre-existing tests/dimensions baseline (which
// posts at current_date). Close review round 1 (VERIFY) finding #6: afterAll force-deletes every
// row this file itself recorded — lines, entries, decisions, periods, fiscal years — in one admin
// transaction under `session_replication_role = replica`, so NOTHING is ever left as residue (the
// older "leave it as documented residue" discipline is retired: with every protective trigger
// disabled for this file's own tracked rows, there is no longer a legitimate reason one of them
// could resist deletion, and unbounded residue would eventually exhaust the synthetic-year range
// below 1950, a real risk once Stryker starts running this file once per mutant).
//
// STATUS: GREEN against pgeos_lane2 (database/migrations/0040_2_accounting-periods.sql applied;
// `modules/billing/{domain,application,infrastructure,api}/accounting-periods/*` all present).
//
// Application surface this file exercises (naming follows the golden slice's own convention,
// modules/wms/application/receive-inbound/*):
//   modules/billing/application/accounting-periods/index.ts
//     - createFiscalYear(ctx, { entityId, startDate, endDate, correlationId, idem? }, deps):
//         { id, version } — D2: CFO role gate (RoleRequiredError otherwise). Writes
//         'billing.fiscal_year.created' (packages/events/catalog.ts:121), aggregate_type
//         'billing.fiscal_years'.
//     - openPeriod(ctx, { entityId, fiscalYearId, startDate, endDate, correlationId, idem? }, deps):
//         { id, version, status: 'open' } — D2: no role gate. Writes
//         'billing.accounting_period.opened' (catalog.ts:126), aggregate_type
//         'billing.accounting_periods'.
//     - closePeriod(ctx, { periodId, expectedVersion, correlationId, idem? }, deps):
//         { version, status: 'closed' } — D2: CFO role gate. Writes
//         'billing.accounting_period.closed' (catalog.ts:127).
//     - lockPeriod(ctx, { periodId, expectedVersion, correlationId, idem? }, deps):
//         { version, status: 'locked' } — D2: CFO role gate. Writes
//         'billing.accounting_period.locked' (catalog.ts:128).
//     - requestReopenPeriod(ctx, { periodId, expectedVersion, correlationId, idem? }, deps):
//         { decisionId } — D2: no role gate (any entity member). D8: legal ONLY from 'closed'
//         (IllegalPeriodTransitionError otherwise, no decision row written; a stale
//         expectedVersion is StaleVersionError). Inserts ONE platform.decisions row (kind
//         'accounting_period_reopen', source_table 'billing.accounting_periods', source_id =
//         periodId, entity_id, status 'open', title_ar (i18n), context jsonb { requestedBy,
//         periodId, entityId, periodVersion, startDate, endDate }, assigned_role READ from
//         platform.approval_chains ('accounting_period_reopen', step 1) — D1, never hard-coded).
//         The period's own status/version are UNCHANGED — no outbox row, no audit row for the
//         period itself (D8).
//     - applyPeriodReopenDecision(ctx, { decisionId, correlationId }, deps): { version, status: 'open' }
//         — INTERNAL (no contract route). D9: throws SelfApprovalNotAllowedError if
//         decision.decided_by = decision.context.requestedBy; throws RoleRequiredError if
//         ctx.userId lacks the chain's approver role (GM) OR ctx.userId != decision.decided_by;
//         throws StaleVersionError if decision.context.periodVersion != the period's CURRENT
//         version (blocks replay after any later close/reopen cycle). On success: the period's
//         status becomes 'open' (machine REOPEN edge), version bumped, writes
//         'billing.accounting_period.reopened' (catalog.ts:129) + one audit row.
//   modules/billing/domain/accounting-periods/errors.ts
//     - StaleVersionError, RoleRequiredError, MissingActorError, PeriodNotFoundError,
//       FiscalYearNotFoundError, SelfApprovalNotAllowedError, IllegalPeriodTransitionError
//       (./period-machine.unit.test.ts already names this one), plus (close review round 1 (c)):
//       FiscalYearOverlapError (23P01), PeriodOverlapError (23P01), PeriodOutsideFiscalYearError
//       (23514), EntityNotInScopeError (42501) — each maps the DB's own structural refusal (D3)
//       into a typed application error instead of a raw Postgres error reaching the caller.
//   modules/billing/domain/accounting-periods/machine.ts — see ./period-machine.unit.test.ts.
//   modules/billing/api/accounting-periods/composition.ts
//     - createAccountingPeriodsDeps({ clock }): deps object the six functions above accept.

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WithContextCtx } from '@pg-eos/db';
import { withContext, type IdempotencyInput } from '@pg-eos/db';
import { FixedClock } from '@pg-eos/domain-kit';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// The modules under test.
import {
  applyPeriodReopenDecision,
  closePeriod,
  createFiscalYear,
  lockPeriod,
  openPeriod,
  requestReopenPeriod,
} from '../../application/accounting-periods/index.js';
import { createAccountingPeriodsDeps } from '../../api/accounting-periods/composition.js';
import {
  EntityNotInScopeError,
  FiscalYearOverlapError,
  IllegalPeriodTransitionError,
  PeriodNotFoundError,
  PeriodOutsideFiscalYearError,
  PeriodOverlapError,
  RoleRequiredError,
  SelfApprovalNotAllowedError,
  StaleVersionError,
} from '../../domain/accounting-periods/errors.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// --- literals (same discipline as ../dimensions/line-dimensions.test.ts: pinned SQLSTATEs) -------

const CHECK_VIOLATION = '23514'; // D4/D5's own constraint-trigger violation.
const EXCLUSION_VIOLATION = '23P01'; // D3: no-overlap EXCLUDE (gist) constraints.
const FK_VIOLATION = '23503'; // D3: fiscal_year_id belonging to another entity.
const INSUFFICIENT_PRIVILEGE = '42501'; // RLS WITH CHECK / column-grant failures.

const CFO_ROLE_CODE = 'CFO';
const GM_ROLE_CODE = 'GM';
const DECISION_KIND = 'accounting_period_reopen';
const DECISION_SOURCE_TABLE = 'billing.accounting_periods';
const APPROVAL_CHAIN_STEP_NO = 1;
const DEFAULT_REOPEN_APPROVER_ROLE = 'GM'; // D1: the row 0040 seeds for (DECISION_KIND, step 1).

const FISCAL_YEAR_CREATED_EVENT = 'billing.fiscal_year.created'; // packages/events/catalog.ts:121.
const PERIOD_OPENED_EVENT = 'billing.accounting_period.opened'; // catalog.ts:126.
const PERIOD_CLOSED_EVENT = 'billing.accounting_period.closed'; // catalog.ts:127.
const PERIOD_LOCKED_EVENT = 'billing.accounting_period.locked'; // catalog.ts:128.
const PERIOD_REOPENED_EVENT = 'billing.accounting_period.reopened'; // catalog.ts:129.
const FISCAL_YEARS_AGGREGATE = 'billing.fiscal_years';
const PERIODS_AGGREGATE = 'billing.accounting_periods';

const GL_ACCOUNT_TYPE = 'expense';

const CFO_ACTOR_UUID = '00000000-0000-4000-8000-0000000419c1';
const PLAIN_ACTOR_UUID = '00000000-0000-4000-8000-0000000419c2'; // pilot entity, no roles — the reopen requester.
const APPROVER_ACTOR_UUID = '00000000-0000-4000-8000-0000000419c3'; // pilot entity, GM role — the legitimate approver.
const NON_GM_ACTOR_UUID = '00000000-0000-4000-8000-0000000419c5'; // pilot entity, no GM role.
const OUTSIDER_ACTOR_UUID = '00000000-0000-4000-8000-0000000419c4'; // scoped only to the outsider entity.

const clock = new FixedClock(new Date('2026-09-28T00:00:00.000Z'));
const deps = createAccountingPeriodsDeps({ clock });

let entityId: string; // code 'PST'.
let outsiderEntityId: string; // code 'PCC' — fixed code, never `limit 1` (precedent: line-dimensions).
let fiscalYearId: string; // pilot entity's own main fiscal year.
let outsiderFiscalYearId: string; // outsider entity's own fiscal year, same window as the pilot's.
let structuralFiscalYearId: string; // pilot entity's SECOND fiscal year, reserved for the D3/D4 structural describe only.
let fyStart: string;
let structuralFyStart: string;
let glAccountId: string;

const insertedPeriodIds: string[] = [];
const insertedFiscalYearIds: string[] = [];
const insertedJournalEntryIds: string[] = [];
const insertedJournalLineIds: string[] = [];
const insertedDecisionIds: string[] = [];
const usedCorrelationIds = new Set<string>();

// --- 4.19 pre-build review finding 1: this file's own synthetic fiscal year ----------------------
const SYNTHETIC_YEAR_FLOOR = 1899;
const SYNTHETIC_YEAR_CUTOFF = '1950-01-01';
const MAIN_FY_LENGTH_DAYS = 600;
const STRUCTURAL_FY_GAP_DAYS = 10; // keeps the structural FY strictly after the main FY ends.
const STRUCTURAL_FY_LENGTH_DAYS = 500;
const PERIOD_LENGTH_DAYS = 14;
const PERIOD_GAP_DAYS = 2;

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A fresh, non-overlapping [startDate, endDate] block on every call, tiling forward from
 *  `baseDate` (4.19 pre-build review finding 2: "each call takes the next distinct non-overlapping
 *  range"). Independent counters per fiscal-year window (main vs. structural) so the two never
 *  interfere. */
function makeRangeAllocator(baseDate: string): () => { startDate: string; endDate: string } {
  let offset = 0;
  return () => {
    const start = offset;
    const end = start + PERIOD_LENGTH_DAYS - 1;
    offset = end + 1 + PERIOD_GAP_DAYS;
    return { startDate: addDays(baseDate, start), endDate: addDays(baseDate, end) };
  };
}

let nextRange: () => { startDate: string; endDate: string };
let nextStructuralRange: () => { startDate: string; endDate: string };

function ctxFor(userId: string): WithContextCtx {
  return { userId, clientId: null, isInternal: true };
}

function freshDocNo(): string {
  return `JE-ACCPER-${randomUUID().slice(0, 8)}`;
}

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

function idemFor(endpoint: string, key: string, body: unknown): IdempotencyInput {
  return {
    key,
    endpoint: `billing.accounting-periods.${endpoint}`,
    requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    entityId: null,
    successStatus: 200,
  };
}

/** Walks `error`'s own cause chain for a Postgres error with the given SQLSTATE — same discipline
 *  as ../dimensions/line-dimensions.test.ts's own findRaisedException. */
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

async function createFixtureActor(userId: string, entityIds: readonly string[]): Promise<void> {
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')
     on conflict (id) do update set email = excluded.email`,
    [userId, `_accper_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار الفترات المحاسبية — WBS 4.19'],
  );
  for (const eid of entityIds) {
    await pool.query(
      `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict (user_id, entity_id) do nothing`,
      [userId, eid],
    );
  }
}

async function assignRole(userId: string, roleCode: string): Promise<void> {
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [roleCode]);
  const roleRow = roleResult.rows[0];
  if (!roleRow) throw new Error(`identity.roles row not found for code '${roleCode}'`);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2) on conflict do nothing`, [userId, roleRow.id]);
}

async function insertFiscalYearFixture(forEntityId: string, startDate: string, endDate: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.fiscal_years (entity_id, start_date, end_date) values ($1, $2, $3) returning id`,
    [forEntityId, startDate, endDate],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture billing.fiscal_years insert returned no id');
  insertedFiscalYearIds.push(row.id);
  return row.id;
}

/** A fresh, OPEN period via the real application command (D2: no role gate on openPeriod) — the
 *  realistic path for every scenario that starts from "an open period exists". */
async function freshOpenPeriod(input: { forEntityId: string; forFiscalYearId: string; startDate: string; endDate: string }): Promise<{
  id: string;
  version: number;
}> {
  const created = await openPeriod(
    ctxFor(PLAIN_ACTOR_UUID),
    {
      entityId: input.forEntityId,
      fiscalYearId: input.forFiscalYearId,
      startDate: input.startDate,
      endDate: input.endDate,
      correlationId: nextCorrelationId(),
    },
    deps,
  );
  insertedPeriodIds.push(created.id);
  return created;
}

/** D4: INSERT is legal ONLY at status 'open' — every admin-pool fixture is created open, then (if
 *  needed) driven to its target status through the ONLY legal edges, via reachStatusViaAdmin. Used
 *  by the structural/D4 describe, which deliberately bypasses the application layer entirely. */
async function insertOpenPeriodAdmin(input: { forEntityId: string; forFiscalYearId: string; startDate: string; endDate: string }): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.accounting_periods (entity_id, fiscal_year_id, start_date, end_date) values ($1, $2, $3, $4) returning id`,
    [input.forEntityId, input.forFiscalYearId, input.startDate, input.endDate],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture billing.accounting_periods insert returned no id');
  insertedPeriodIds.push(row.id);
  return row.id;
}

/** Close review round 1 (VERIFY) finding #1: the 0040 guard now also refuses `new.version <
 *  old.version` and any status change whose `new.version <> old.version + 1` — every legal
 *  open->closed[->locked] admin-pool advance below bumps version by exactly 1 per edge, so a
 *  legal status change is never coincidentally refused by the version guard. */
async function reachStatusViaAdmin(periodId: string, target: 'open' | 'closed' | 'locked'): Promise<void> {
  if (target === 'open') return;
  await pool.query(`update billing.accounting_periods set status = 'closed', version = version + 1 where id = $1`, [periodId]);
  if (target === 'locked') {
    await pool.query(`update billing.accounting_periods set status = 'locked', version = version + 1 where id = $1`, [periodId]);
  }
}

async function getPeriod(id: string): Promise<{ status: string; version: number }> {
  const result: QueryResult<{ status: string; version: number }> = await pool.query(
    `select status, version from billing.accounting_periods where id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no billing.accounting_periods row for id ${id}`);
  return row;
}

/** 0041 (WBS 4.20): entry_type is NOT NULL ('accrual' — a non-manual type) and balance is enforced
 *  at COMMIT, so the entry is written with two balanced lines in ONE transaction (posted_at stays
 *  null: UNPOSTED, so 0041's posted-immutability triggers do not pre-empt the period triggers
 *  under test). A refusal by the period trigger is raised at the entry insert, before any line, and
 *  is rethrown unchanged. The lines this creates are tracked for afterAll cleanup. Returns the
 *  entry's id in the same QueryResult shape as before. */
const accountByEntity = new Map<string, string>();
const insertedExtraGlAccountIds: string[] = [];

async function glAccountFor(forEntityId: string): Promise<string> {
  if (forEntityId === entityId) return glAccountId;
  const known = accountByEntity.get(forEntityId);
  if (known) return known;
  const created = await insertGlAccount(forEntityId);
  insertedExtraGlAccountIds.push(created);
  accountByEntity.set(forEntityId, created);
  return created;
}

async function insertJournalEntryAdmin(input: { forEntityId: string; entryDate: string; periodId?: string | null }): Promise<QueryResult<{ id: string }>> {
  const accountId = await glAccountFor(input.forEntityId);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const entry: QueryResult<{ id: string }> = await client.query(
      `insert into billing.journal_entries (entity_id, doc_no, entry_date, description, period_id, entry_type)
       values ($1, $2, $3, $4, $5, 'accrual') returning id`,
      [input.forEntityId, freshDocNo(), input.entryDate, 'قيد اختبار الفترات المحاسبية — WBS 4.19', input.periodId ?? null],
    );
    const entryRow = entry.rows[0];
    if (!entryRow) throw new Error('fixture billing.journal_entries insert returned no row');
    const lines: QueryResult<{ id: string }> = await client.query(
      `insert into billing.journal_lines (entry_id, account_id, debit, credit)
       values ($1, $2, 100.000, 0), ($1, $2, 0, 100.000) returning id`,
      [entryRow.id, accountId],
    );
    await client.query('commit');
    for (const row of lines.rows) insertedJournalLineIds.push(row.id);
    return entry;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** An UNPOSTED entry with NO lines, inserted as the owner under session_replication_role = replica
 *  (bypasses balance-at-commit only for this fixture insert). Used where the test's intent is the
 *  DELETE of an entry by the period trigger: with no lines the FK does not pre-empt it, and being
 *  unposted the 0041 immutability trigger lets the DELETE through to the period trigger. */
async function insertLinelessUnpostedJournalEntryAdmin(input: { forEntityId: string; entryDate: string; periodId: string }): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local session_replication_role = replica`);
    const entry: QueryResult<{ id: string }> = await client.query(
      `insert into billing.journal_entries (entity_id, doc_no, entry_date, description, period_id, entry_type)
       values ($1, $2, $3, $4, $5, 'accrual') returning id`,
      [input.forEntityId, freshDocNo(), input.entryDate, 'قيد اختبار الفترات المحاسبية — WBS 4.19', input.periodId],
    );
    await client.query('commit');
    const row = entry.rows[0];
    if (!row) throw new Error('fixture billing.journal_entries insert returned no row');
    return row.id;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function insertGlAccount(forEntityId: string): Promise<string> {
  const seg2 = String(Math.floor(Math.random() * 100)).padStart(2, '0');
  const seg3a = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  const seg3b = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  const code = `9-${seg2}-${seg3a}-${seg3b}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.gl_accounts (entity_id, code, name_ar, account_type) values ($1, $2, $3, $4) returning id`,
    [forEntityId, code, 'حساب اختبار الفترات المحاسبية — WBS 4.19', GL_ACCOUNT_TYPE],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture billing.gl_accounts insert returned no id');
  return row.id;
}

async function insertJournalLineAdmin(entryId: string): Promise<QueryResult<{ id: string }>> {
  return pool.query(`insert into billing.journal_lines (entry_id, account_id, debit, credit) values ($1, $2, 100.000, 0) returning id`, [entryId, glAccountId]);
}

/** A BALANCED pair (one debit, one credit, same amount) in ONE statement — 4.19 pre-build review
 *  (VERIFY round) finding B: a single debit-only line left behind as undeletable residue (once its
 *  period is closed) makes that JE-ACCPER-* entry permanently UNBALANCED, failing guard G2 on
 *  every later run. Every line this file leaves as residue must be part of a balanced pair — same
 *  discipline as ../dimensions/line-dimensions.test.ts's own freshLine(). */
async function insertBalancedJournalLinePair(entryId: string): Promise<{ debitId: string; creditId: string }> {
  const result: QueryResult<{ id: string; debit: string }> = await pool.query(
    `insert into billing.journal_lines (entry_id, account_id, debit, credit)
     values ($1, $2, 100.000, 0), ($1, $2, 0, 100.000) returning id, debit::text as debit`,
    [entryId, glAccountId],
  );
  const debitRow = result.rows.find((row) => Number(row.debit) > 0);
  const creditRow = result.rows.find((row) => Number(row.debit) === 0);
  if (!debitRow || !creditRow || result.rows.length !== 2) {
    throw new Error('fixture billing.journal_lines insert did not return a balanced debit/credit pair');
  }
  return { debitId: debitRow.id, creditId: creditRow.id };
}

async function outboxRowsForCorrelationAndType(correlationId: string, eventType: string): Promise<Array<{ id: string; aggregate_id: string; aggregate_type: string }>> {
  const result: QueryResult<{ id: string; aggregate_id: string; aggregate_type: string }> = await pool.query(
    `select id::text as id, aggregate_id::text as aggregate_id, aggregate_type
       from platform.outbox where correlation_id = $1 and event_type = $2`,
    [correlationId, eventType],
  );
  return result.rows;
}

async function outboxCountForCorrelation(correlationId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(`select count(*)::text as n from platform.outbox where correlation_id = $1`, [correlationId]);
  return Number(result.rows[0]?.n ?? '0');
}

async function auditCountForCorrelation(correlationId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(`select count(*)::text as n from platform.audit_log where correlation_id = $1`, [correlationId]);
  return Number(result.rows[0]?.n ?? '0');
}

async function assertOutboxEvent(correlationId: string, eventType: string, aggregateId: string, aggregateType: string): Promise<void> {
  const rows = await outboxRowsForCorrelationAndType(correlationId, eventType);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.aggregate_id).toBe(aggregateId);
  expect(rows[0]?.aggregate_type).toBe(aggregateType);
  expect(await auditCountForCorrelation(correlationId)).toBe(1);
}

async function assertNoWriteForCorrelation(correlationId: string): Promise<void> {
  expect(await outboxCountForCorrelation(correlationId)).toBe(0);
  expect(await auditCountForCorrelation(correlationId)).toBe(0);
}

async function getDecision(id: string): Promise<{
  kind: string;
  source_table: string;
  source_id: string;
  entity_id: string;
  status: string;
  assigned_role: string;
  title_ar: string;
  context: Record<string, unknown>;
}> {
  const result: QueryResult<{
    kind: string;
    source_table: string;
    source_id: string;
    entity_id: string;
    status: string;
    assigned_role: string;
    title_ar: string;
    context: Record<string, unknown>;
  }> = await pool.query(
    `select kind, source_table, source_id::text as source_id, entity_id::text as entity_id, status, assigned_role, title_ar, context
       from platform.decisions where id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no platform.decisions row for id ${id}`);
  return row;
}

async function decisionCountForSource(periodId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.decisions where kind = $1 and source_id = $2`,
    [DECISION_KIND, periodId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function markDecisionDecided(decisionId: string, decidedBy: string, decision: 'approved' | 'rejected'): Promise<void> {
  await pool.query(`update platform.decisions set status = 'decided', decision = $2, decided_by = $3, decided_at = now() where id = $1`, [
    decisionId,
    decision,
    decidedBy,
  ]);
}

async function getApprovalChainApproverRole(): Promise<string> {
  const result: QueryResult<{ approver_role: string }> = await pool.query(
    `select approver_role from platform.approval_chains where request_type = $1 and step_no = $2`,
    [DECISION_KIND, APPROVAL_CHAIN_STEP_NO],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`platform.approval_chains row not found for ('${DECISION_KIND}', step ${APPROVAL_CHAIN_STEP_NO})`);
  return row.approver_role;
}

async function setApprovalChainApproverRole(role: string): Promise<void> {
  await pool.query(`update platform.approval_chains set approver_role = $2 where request_type = $1 and step_no = $3`, [
    DECISION_KIND,
    role,
    APPROVAL_CHAIN_STEP_NO,
  ]);
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

  await createFixtureActor(CFO_ACTOR_UUID, [entityId]);
  await assignRole(CFO_ACTOR_UUID, CFO_ROLE_CODE);
  await createFixtureActor(PLAIN_ACTOR_UUID, [entityId]);
  await createFixtureActor(APPROVER_ACTOR_UUID, [entityId]);
  await assignRole(APPROVER_ACTOR_UUID, GM_ROLE_CODE); // 4.19 pre-build review finding 8(i).
  await createFixtureActor(NON_GM_ACTOR_UUID, [entityId]);
  await createFixtureActor(OUTSIDER_ACTOR_UUID, [outsiderEntityId]);

  const year = await pickSyntheticYear([entityId, outsiderEntityId]);
  fyStart = `${year}-01-01`;
  const fyEnd = addDays(fyStart, MAIN_FY_LENGTH_DAYS - 1);
  structuralFyStart = addDays(fyStart, MAIN_FY_LENGTH_DAYS + STRUCTURAL_FY_GAP_DAYS);
  const structuralFyEnd = addDays(structuralFyStart, STRUCTURAL_FY_LENGTH_DAYS - 1);

  fiscalYearId = await insertFiscalYearFixture(entityId, fyStart, fyEnd);
  outsiderFiscalYearId = await insertFiscalYearFixture(outsiderEntityId, fyStart, fyEnd);
  structuralFiscalYearId = await insertFiscalYearFixture(entityId, structuralFyStart, structuralFyEnd);

  nextRange = makeRangeAllocator(fyStart);
  nextStructuralRange = makeRangeAllocator(structuralFyStart);

  glAccountId = await insertGlAccount(entityId);

  // Confirm withContext genuinely connects as pgeos_app before trusting any RLS/grant assertion
  // (same discipline as ../dimensions/line-dimensions.test.ts's own beforeAll).
  const currentUserResult = await withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => tx.execute<{ current_user: string }>(sql`select current_user`));
  expect(currentUserResult.rows[0]?.['current_user']).toBe('pgeos_app');
});

afterAll(async () => {
  // Close review round 1 (VERIFY) finding #6: residue exhausts the synthetic years below 1950 (the
  // picker moves the year forward every run; Stryker runs this file once PER MUTANT). Every row
  // this file itself recorded — lines, entries, decisions, periods, fiscal years — is force-deleted
  // in ONE admin transaction, `session_replication_role = replica` (bypasses the closed/locked-
  // posting and immutable-column triggers — safe here because these are this file's OWN tracked
  // rows, never another file's or another lane's). This REPLACES the older "leave it as documented
  // residue" discipline entirely — a cleanup failure now throws (never silently swallowed), because
  // with every protective trigger disabled there is no longer a legitimate reason for one of this
  // file's own rows to resist deletion. platform.outbox and platform.audit_log are NEVER touched
  // (append-only ledgers, D-183) — nothing above writes to either.
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local session_replication_role = replica`);
    if (insertedJournalLineIds.length > 0) {
      await client.query(`delete from billing.journal_lines where id = any($1::uuid[])`, [insertedJournalLineIds]);
    }
    if (insertedJournalEntryIds.length > 0) {
      await client.query(`delete from billing.journal_entries where id = any($1::uuid[])`, [insertedJournalEntryIds]);
    }
    if (insertedDecisionIds.length > 0) {
      await client.query(`delete from platform.decisions where id = any($1::uuid[])`, [insertedDecisionIds]);
    }
    if (insertedPeriodIds.length > 0) {
      await client.query(`delete from billing.accounting_periods where id = any($1::uuid[])`, [insertedPeriodIds]);
    }
    if (insertedFiscalYearIds.length > 0) {
      await client.query(`delete from billing.fiscal_years where id = any($1::uuid[])`, [insertedFiscalYearIds]);
    }
    if (glAccountId) {
      await client.query(`delete from billing.gl_accounts where id = any($1::uuid[])`, [[glAccountId, ...insertedExtraGlAccountIds]]);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error; // a genuine cleanup failure must be visible, never silently swallowed.
  } finally {
    client.release();
  }

  try {
    const actorIds = [CFO_ACTOR_UUID, PLAIN_ACTOR_UUID, APPROVER_ACTOR_UUID, NON_GM_ACTOR_UUID, OUTSIDER_ACTOR_UUID];
    await pool.query(`delete from platform.idempotency_keys where user_id = any($1::uuid[])`, [actorIds]);
    await pool.query(`delete from identity.user_roles where user_id = any($1::uuid[])`, [actorIds]);
    await pool.query(`delete from identity.user_entities where user_id = any($1::uuid[])`, [actorIds]);
    await pool.query(`delete from identity.users where id = any($1::uuid[])`, [actorIds]);
  } catch {
    // best-effort only — fixture actors, not billing data.
  }
  await pool.end();
});

// --- Scenario: A journal entry dated inside an open period of its entity is accepted -------------

describe('Scenario: A journal entry dated inside an open period of its entity is accepted', () => {
  it('the insert succeeds', async () => {
    const range = nextRange();
    const period = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...range });
    const result = await insertJournalEntryAdmin({ forEntityId: entityId, entryDate: range.startDate, periodId: period.id });
    const id = result.rows[0]?.id;
    if (!id) throw new Error('expected the insert to return an id');
    insertedJournalEntryIds.push(id);
  });
});

// --- Scenario: A journal entry dated inside a closed period is rejected by the database ------------

describe('Scenario: A journal entry dated inside a closed period is rejected by the database (not only the domain)', () => {
  it('insert and delete-from a closed period are refused by the 0040 period rule, an entry UPDATE by the 0041 immutability rule (chk_journal_entry_immutable) — all 23514, including through a genuine pgeos_app session', async () => {
    const range = nextRange();
    const period = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...range });

    const preExisting = await insertJournalEntryAdmin({ forEntityId: entityId, entryDate: range.startDate, periodId: period.id });
    const preExistingId = preExisting.rows[0]?.id;
    if (!preExistingId) throw new Error('expected the pre-close insert to return an id');
    insertedJournalEntryIds.push(preExistingId);
    // 0041: the DELETE below targets an unposted entry with no lines, so the period trigger (not the
    // lines FK, not the posted-immutability trigger) is what refuses it.
    const linelessId = await insertLinelessUnpostedJournalEntryAdmin({ forEntityId: entityId, entryDate: range.startDate, periodId: period.id });
    insertedJournalEntryIds.push(linelessId);

    await closePeriod(ctxFor(CFO_ACTOR_UUID), { periodId: period.id, expectedVersion: period.version, correlationId: nextCorrelationId() }, deps);
    expect((await getPeriod(period.id)).status).toBe('closed');

    await expect(insertJournalEntryAdmin({ forEntityId: entityId, entryDate: range.startDate })).rejects.toMatchObject({ code: CHECK_VIOLATION });

    await expect(
      pool.query(`update billing.journal_entries set description = $2 where id = $1`, [preExistingId, 'محاولة تعديل قيد في فترة مقفلة']),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: 'chk_journal_entry_immutable' });

    await expect(pool.query(`delete from billing.journal_entries where id = $1`, [linelessId])).rejects.toMatchObject({ code: CHECK_VIOLATION });

    // 4.19 pre-build review finding 18: the SAME refusal through a genuine pgeos_app session, not
    // only the admin/superuser pool.
    let appInsertRejection: unknown;
    try {
      await withContext(ctxFor(PLAIN_ACTOR_UUID), async (tx: NodePgDatabase) =>
        tx.execute(
          sql`insert into billing.journal_entries (entity_id, doc_no, entry_date, description, entry_type)
              values (${entityId}, ${freshDocNo()}, ${range.startDate}, ${'قيد اختبار عبر pgeos_app'}, 'accrual')`,
        ),
      );
    } catch (error) {
      appInsertRejection = error;
    }
    expect(findRaisedException(appInsertRejection, CHECK_VIOLATION)).toBeDefined();
  });

  it('an entry whose entry_date is later UPDATED into a closed period is refused (23514) by the 0041 immutability rule (chk_journal_entry_immutable), not the 0040 period rule', async () => {
    const targetRange = nextRange();
    const targetPeriod = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...targetRange });
    await closePeriod(ctxFor(CFO_ACTOR_UUID), { periodId: targetPeriod.id, expectedVersion: targetPeriod.version, correlationId: nextCorrelationId() }, deps);

    // An uncovered date — far outside every period this file's counter will ever allocate.
    const uncoveredDate = addDays(fyStart, MAIN_FY_LENGTH_DAYS - 3);
    const entryResult = await insertJournalEntryAdmin({ forEntityId: entityId, entryDate: uncoveredDate });
    const entryId = entryResult.rows[0]?.id;
    if (!entryId) throw new Error('expected the uncovered-date insert to succeed and return an id');
    insertedJournalEntryIds.push(entryId);

    await expect(
      pool.query(`update billing.journal_entries set entry_date = $2 where id = $1`, [entryId, targetRange.startDate]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: 'chk_journal_entry_immutable' });
    const afterResult: QueryResult<{ entry_date: string }> = await pool.query(`select entry_date::text as entry_date from billing.journal_entries where id = $1`, [
      entryId,
    ]);
    expect(afterResult.rows[0]?.entry_date).toBe(uncoveredDate);
  });

  it("changing an existing entry's entity_id is refused (23514) by the 0041 immutability rule (chk_journal_entry_immutable), not the 0040 period rule", async () => {
    const pccRange = nextRange();
    const pccPeriod = await openPeriod(
      ctxFor(OUTSIDER_ACTOR_UUID),
      { entityId: outsiderEntityId, fiscalYearId: outsiderFiscalYearId, startDate: pccRange.startDate, endDate: pccRange.endDate, correlationId: nextCorrelationId() },
      deps,
    );
    insertedPeriodIds.push(pccPeriod.id);
    // Closed via the admin pool (not the real closePeriod command, which is CFO-role-gated and
    // whose repository lookup is RLS-scoped — this test's own CFO fixture is deliberately scoped
    // to the pilot entity only elsewhere in this file and must stay that way). This test's own
    // intent is only "PCC's covering period is closed" as a DB fact, already proven elsewhere
    // (Scenario "Close is a CFO action") that closePeriod itself is genuinely CFO-gated.
    await reachStatusViaAdmin(pccPeriod.id, 'closed');

    // The PST entry has NO covering period at all for pccRange.startDate (PST's own periods live
    // in entirely different sub-ranges allocated by nextRange()).
    const entryResult = await insertJournalEntryAdmin({ forEntityId: entityId, entryDate: pccRange.startDate });
    const entryId = entryResult.rows[0]?.id;
    if (!entryId) throw new Error('expected the PST uncovered-date insert to succeed and return an id');
    insertedJournalEntryIds.push(entryId);

    await expect(pool.query(`update billing.journal_entries set entity_id = $2 where id = $1`, [entryId, outsiderEntityId])).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'chk_journal_entry_immutable',
    });
  });

  it('inserting, updating, or deleting a billing.journal_lines row of an entry dated inside the closed period is refused (23514) — D5 reaches lines via their parent entry', async () => {
    const range = nextRange();
    const period = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...range });

    const entryResult = await insertJournalEntryAdmin({ forEntityId: entityId, entryDate: range.startDate, periodId: period.id });
    const entryId = entryResult.rows[0]?.id;
    if (!entryId) throw new Error('expected the pre-close entry insert to return an id');
    insertedJournalEntryIds.push(entryId);

    // A BALANCED pair (one debit, one credit) while the period is still open — must succeed. Any
    // line this test leaves behind as undeletable residue (once the period below is closed) must
    // never leave its own entry unbalanced (guard G2) — a lone debit-only line would.
    const pair = await insertBalancedJournalLinePair(entryId);
    insertedJournalLineIds.push(pair.debitId, pair.creditId);

    await closePeriod(ctxFor(CFO_ACTOR_UUID), { periodId: period.id, expectedVersion: period.version, correlationId: nextCorrelationId() }, deps);

    await expect(insertJournalLineAdmin(entryId)).rejects.toMatchObject({ code: CHECK_VIOLATION }); // a NEW line, now refused (never persisted — no residue risk).
    await expect(pool.query(`update billing.journal_lines set debit = 200.000 where id = $1`, [pair.debitId])).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(pool.query(`delete from billing.journal_lines where id = $1`, [pair.debitId])).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});

// --- Scenario: A journal entry dated inside a locked period is rejected by the database -----------

describe('Scenario: A journal entry dated inside a locked period is rejected by the database', () => {
  it('insert is refused (23514), exactly as for a closed period', async () => {
    const range = nextRange();
    const period = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...range });
    const closed = await closePeriod(ctxFor(CFO_ACTOR_UUID), { periodId: period.id, expectedVersion: period.version, correlationId: nextCorrelationId() }, deps);
    await lockPeriod(ctxFor(CFO_ACTOR_UUID), { periodId: period.id, expectedVersion: closed.version, correlationId: nextCorrelationId() }, deps);
    expect((await getPeriod(period.id)).status).toBe('locked');

    await expect(insertJournalEntryAdmin({ forEntityId: entityId, entryDate: range.startDate })).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});

// --- Scenario: Periods are per entity ---------------------------------------------------------------

describe("Scenario: Periods are per entity — closing a period of one entity leaves the other entities' periods open", () => {
  it("closing the pilot entity's period refuses posting for it, but the outsider entity's own covering period stays open", async () => {
    const range = nextRange();
    const pilotPeriod = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...range });
    const outsiderPeriod = await openPeriod(
      ctxFor(OUTSIDER_ACTOR_UUID),
      { entityId: outsiderEntityId, fiscalYearId: outsiderFiscalYearId, startDate: range.startDate, endDate: range.endDate, correlationId: nextCorrelationId() },
      deps,
    );
    insertedPeriodIds.push(outsiderPeriod.id);

    await closePeriod(ctxFor(CFO_ACTOR_UUID), { periodId: pilotPeriod.id, expectedVersion: pilotPeriod.version, correlationId: nextCorrelationId() }, deps);

    await expect(insertJournalEntryAdmin({ forEntityId: entityId, entryDate: range.startDate })).rejects.toMatchObject({ code: CHECK_VIOLATION });

    const outsiderInsert = await insertJournalEntryAdmin({ forEntityId: outsiderEntityId, entryDate: range.startDate });
    const outsiderEntryId = outsiderInsert.rows[0]?.id;
    if (!outsiderEntryId) throw new Error('expected the outsider entity insert to succeed and return an id');
    insertedJournalEntryIds.push(outsiderEntryId);
  });
});

// --- Scenario: Close is a CFO action; every state change writes one outbox row and one audit row ---

describe('Scenario: Close is a CFO action (OD-12); every state change writes one outbox row and one audit row in the same transaction', () => {
  it('a non-CFO caller is refused for close, lock, and createFiscalYear (nothing written); the CFO succeeds (exactly one outbox row, one audit row)', async () => {
    const range = nextRange();
    const period = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...range });

    const forbiddenCloseCorrelationId = nextCorrelationId();
    await expect(
      closePeriod(ctxFor(PLAIN_ACTOR_UUID), { periodId: period.id, expectedVersion: period.version, correlationId: forbiddenCloseCorrelationId }, deps),
    ).rejects.toBeInstanceOf(RoleRequiredError);
    expect((await getPeriod(period.id)).status).toBe('open');
    await assertNoWriteForCorrelation(forbiddenCloseCorrelationId);

    const closeCorrelationId = nextCorrelationId();
    const closed = await closePeriod(ctxFor(CFO_ACTOR_UUID), { periodId: period.id, expectedVersion: period.version, correlationId: closeCorrelationId }, deps);
    expect(closed.status).toBe('closed');
    await assertOutboxEvent(closeCorrelationId, PERIOD_CLOSED_EVENT, period.id, PERIODS_AGGREGATE);
  });

  // 4.19 pre-build review finding 10: D2 gates createFiscalYear too.
  it('createFiscalYear: a non-CFO caller is refused (nothing written); the CFO succeeds with exactly one outbox row and one audit row', async () => {
    const forbiddenCorrelationId = nextCorrelationId();
    await expect(
      createFiscalYear(ctxFor(PLAIN_ACTOR_UUID), { entityId, startDate: structuralFyStart, endDate: structuralFyStart, correlationId: forbiddenCorrelationId }, deps),
    ).rejects.toBeInstanceOf(RoleRequiredError);
    await assertNoWriteForCorrelation(forbiddenCorrelationId);

    const correlationId = nextCorrelationId();
    const nextFyStart = addDays(structuralFyStart, STRUCTURAL_FY_LENGTH_DAYS + STRUCTURAL_FY_GAP_DAYS);
    const nextFyEnd = addDays(nextFyStart, 30);
    const created = await createFiscalYear(ctxFor(CFO_ACTOR_UUID), { entityId, startDate: nextFyStart, endDate: nextFyEnd, correlationId }, deps);
    insertedFiscalYearIds.push(created.id);
    await assertOutboxEvent(correlationId, FISCAL_YEAR_CREATED_EVENT, created.id, FISCAL_YEARS_AGGREGATE);
  });

  it('openPeriod writes exactly one outbox row and one audit row (D2: no role gate — the PLAIN actor succeeds)', async () => {
    const range = nextRange();
    const correlationId = nextCorrelationId();
    const opened = await openPeriod(ctxFor(PLAIN_ACTOR_UUID), { entityId, fiscalYearId, startDate: range.startDate, endDate: range.endDate, correlationId }, deps);
    insertedPeriodIds.push(opened.id);
    await assertOutboxEvent(correlationId, PERIOD_OPENED_EVENT, opened.id, PERIODS_AGGREGATE);
  });

  it('lockPeriod writes exactly one outbox row and one audit row; a non-CFO caller is refused (nothing written)', async () => {
    const range = nextRange();
    const period = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...range });
    const closed = await closePeriod(ctxFor(CFO_ACTOR_UUID), { periodId: period.id, expectedVersion: period.version, correlationId: nextCorrelationId() }, deps);

    const forbiddenCorrelationId = nextCorrelationId();
    await expect(
      lockPeriod(ctxFor(PLAIN_ACTOR_UUID), { periodId: period.id, expectedVersion: closed.version, correlationId: forbiddenCorrelationId }, deps),
    ).rejects.toBeInstanceOf(RoleRequiredError);
    expect((await getPeriod(period.id)).status).toBe('closed');
    await assertNoWriteForCorrelation(forbiddenCorrelationId);

    const correlationId = nextCorrelationId();
    const locked = await lockPeriod(ctxFor(CFO_ACTOR_UUID), { periodId: period.id, expectedVersion: closed.version, correlationId }, deps);
    expect(locked.status).toBe('locked');
    await assertOutboxEvent(correlationId, PERIOD_LOCKED_EVENT, period.id, PERIODS_AGGREGATE);
  });
});

// --- Scenario: Reopen goes through the Decision Inbox, never a direct update -----------------------

describe('Scenario: Reopen goes through the Decision Inbox (OD-12), never a direct update', () => {
  it('requesting a reopen of an OPEN or a LOCKED period is refused (IllegalPeriodTransitionError), with no decision row filed', async () => {
    const openRange = nextRange();
    const openPeriodFixture = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...openRange });
    await expect(
      requestReopenPeriod(ctxFor(PLAIN_ACTOR_UUID), { periodId: openPeriodFixture.id, expectedVersion: openPeriodFixture.version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(IllegalPeriodTransitionError);
    expect(await decisionCountForSource(openPeriodFixture.id)).toBe(0);

    const lockedRange = nextRange();
    const lockedPeriodFixture = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...lockedRange });
    const closedFixture = await closePeriod(
      ctxFor(CFO_ACTOR_UUID),
      { periodId: lockedPeriodFixture.id, expectedVersion: lockedPeriodFixture.version, correlationId: nextCorrelationId() },
      deps,
    );
    const lockedFixture = await lockPeriod(ctxFor(CFO_ACTOR_UUID), { periodId: lockedPeriodFixture.id, expectedVersion: closedFixture.version, correlationId: nextCorrelationId() }, deps);
    expect(lockedFixture.status).toBe('locked');
    await expect(
      requestReopenPeriod(
        ctxFor(PLAIN_ACTOR_UUID),
        { periodId: lockedPeriodFixture.id, expectedVersion: lockedFixture.version, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(IllegalPeriodTransitionError);
    expect(await decisionCountForSource(lockedPeriodFixture.id)).toBe(0);
  });

  // D1: the approver role is READ from platform.approval_chains, never hard-coded — proven by
  // temporarily changing the seeded row and observing the SAME request pick up the new value.
  it('the assigned_role on the filed decision is read from platform.approval_chains(accounting_period_reopen, step 1), not a hard-coded literal', async () => {
    const originalRole = await getApprovalChainApproverRole();
    expect(originalRole).toBe(DEFAULT_REOPEN_APPROVER_ROLE);

    const range = nextRange();
    const period = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...range });
    const closed = await closePeriod(ctxFor(CFO_ACTOR_UUID), { periodId: period.id, expectedVersion: period.version, correlationId: nextCorrelationId() }, deps);

    try {
      await setApprovalChainApproverRole(CFO_ROLE_CODE);
      const requested = await requestReopenPeriod(ctxFor(PLAIN_ACTOR_UUID), { periodId: period.id, expectedVersion: closed.version, correlationId: nextCorrelationId() }, deps);
      insertedDecisionIds.push(requested.decisionId);
      const decisionRow = await getDecision(requested.decisionId);
      expect(decisionRow.assigned_role).toBe(CFO_ROLE_CODE);
    } finally {
      await setApprovalChainApproverRole(originalRole);
    }
  });

  // Close review round 1 (VERIFY) finding #2 — the NEW trigger billing.guard_period_reopen_decision
  // on platform.decisions: an RLS-scoped INSERT of kind 'accounting_period_reopen' whose
  // context->>'requestedBy' does not match the CURRENT session user is refused, and once such a
  // row exists, its own kind/context/source_table/source_id/entity_id can never be changed.
  it('a forged requestedBy on a direct INSERT is refused (23514); a context UPDATE on an existing reopen decision is refused (23514)', async () => {
    const range = nextRange();
    const period = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...range });
    const closed = await closePeriod(ctxFor(CFO_ACTOR_UUID), { periodId: period.id, expectedVersion: period.version, correlationId: nextCorrelationId() }, deps);

    // The session user is PLAIN_ACTOR_UUID, but context claims APPROVER_ACTOR_UUID requested it.
    const forgedContext = JSON.stringify({
      requestedBy: APPROVER_ACTOR_UUID,
      periodId: period.id,
      entityId,
      periodVersion: closed.version,
      startDate: range.startDate,
      endDate: range.endDate,
    });
    let forgedInsertRejection: unknown;
    try {
      await withContext(ctxFor(PLAIN_ACTOR_UUID), async (tx: NodePgDatabase) =>
        tx.execute(
          sql`insert into platform.decisions (kind, source_table, source_id, entity_id, status, assigned_role, title_ar, context)
              values (${DECISION_KIND}, ${DECISION_SOURCE_TABLE}, ${period.id}, ${entityId}, 'open', ${DEFAULT_REOPEN_APPROVER_ROLE}, ${'طلب إعادة فتح فترة محاسبية — اختبار'}, ${forgedContext}::jsonb)`,
        ),
      );
    } catch (error) {
      forgedInsertRejection = error;
    }
    expect(findRaisedException(forgedInsertRejection, CHECK_VIOLATION)).toBeDefined();
    expect(await decisionCountForSource(period.id)).toBe(0); // nothing written by the forged attempt.

    // A LEGITIMATE decision, via the real command — its own context can never be changed afterwards.
    const requested = await requestReopenPeriod(ctxFor(PLAIN_ACTOR_UUID), { periodId: period.id, expectedVersion: closed.version, correlationId: nextCorrelationId() }, deps);
    insertedDecisionIds.push(requested.decisionId);

    let contextUpdateRejection: unknown;
    try {
      await withContext(ctxFor(PLAIN_ACTOR_UUID), async (tx: NodePgDatabase) =>
        tx.execute(sql`update platform.decisions set context = context || '{"tampered":true}'::jsonb where id = ${requested.decisionId}`),
      );
    } catch (error) {
      contextUpdateRejection = error;
    }
    expect(findRaisedException(contextUpdateRejection, CHECK_VIOLATION)).toBeDefined();
  });

  it('the request files a decision and leaves the period closed; a direct UPDATE is refused (even after self-approval); a non-GM approver is refused; a DIFFERENT GM approver reopens it; re-applying the decision after a second close is a stale replay', async () => {
    const range = nextRange();
    const period = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...range });
    const closed = await closePeriod(ctxFor(CFO_ACTOR_UUID), { periodId: period.id, expectedVersion: period.version, correlationId: nextCorrelationId() }, deps);

    const requestCorrelationId = nextCorrelationId();
    const requested = await requestReopenPeriod(ctxFor(PLAIN_ACTOR_UUID), { periodId: period.id, expectedVersion: closed.version, correlationId: requestCorrelationId }, deps);
    insertedDecisionIds.push(requested.decisionId);

    const decisionRow = await getDecision(requested.decisionId);
    expect(decisionRow.kind).toBe(DECISION_KIND);
    expect(decisionRow.source_table).toBe(DECISION_SOURCE_TABLE);
    expect(decisionRow.source_id).toBe(period.id);
    expect(decisionRow.entity_id).toBe(entityId);
    expect(decisionRow.status).toBe('open');
    expect(decisionRow.assigned_role).toBe(DEFAULT_REOPEN_APPROVER_ROLE);
    expect(decisionRow.title_ar.length).toBeGreaterThan(0);
    expect(decisionRow.context['requestedBy']).toBe(PLAIN_ACTOR_UUID);
    expect(decisionRow.context['periodId']).toBe(period.id);
    expect(decisionRow.context['entityId']).toBe(entityId);
    expect(decisionRow.context['periodVersion']).toBe(closed.version);
    expect(decisionRow.context['startDate']).toBe(range.startDate);
    expect(decisionRow.context['endDate']).toBe(range.endDate);

    // The period itself is UNCHANGED by the request alone — no outbox/audit row for it either.
    expect(await getPeriod(period.id)).toEqual({ status: 'closed', version: closed.version });
    await assertNoWriteForCorrelation(requestCorrelationId);

    // DB backstop: a direct status flip with no decided/approved decision behind it is refused.
    // Close review round 1 (VERIFY) finding #1: version bumped correctly (old.version + 1) so the
    // refusal below can be attributed ONLY to the missing/invalid decision, never to guard (a)'s
    // own version-consistency check.
    await expect(
      pool.query(`update billing.accounting_periods set status = 'open', version = version + 1 where id = $1`, [period.id]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    // Self-approval (decided_by = the original requester) is refused by the application (SoD) —
    // and the DB backstop refuses a direct update even after that self-approval is recorded.
    await markDecisionDecided(requested.decisionId, PLAIN_ACTOR_UUID, 'approved');
    await expect(
      applyPeriodReopenDecision(ctxFor(PLAIN_ACTOR_UUID), { decisionId: requested.decisionId, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(SelfApprovalNotAllowedError);
    expect((await getPeriod(period.id)).status).toBe('closed');

    let selfApprovedDirectUpdateRejection: unknown;
    try {
      // Version bumped correctly (finding #1) — isolates the refusal to the decision check alone.
      await withContext(ctxFor(PLAIN_ACTOR_UUID), async (tx: NodePgDatabase) =>
        tx.execute(sql`update billing.accounting_periods set status = 'open', version = version + 1 where id = ${period.id}`),
      );
    } catch (error) {
      selfApprovedDirectUpdateRejection = error;
    }
    expect(findRaisedException(selfApprovedDirectUpdateRejection, CHECK_VIOLATION)).toBeDefined();

    // A DIFFERENT approver who lacks the GM role is refused (RoleRequiredError); nothing changes.
    await markDecisionDecided(requested.decisionId, NON_GM_ACTOR_UUID, 'approved');
    await expect(
      applyPeriodReopenDecision(ctxFor(NON_GM_ACTOR_UUID), { decisionId: requested.decisionId, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(RoleRequiredError);
    expect((await getPeriod(period.id)).status).toBe('closed');

    // The legitimate, GM-holding, DIFFERENT approver reopens it.
    await markDecisionDecided(requested.decisionId, APPROVER_ACTOR_UUID, 'approved');
    const applyCorrelationId = nextCorrelationId();
    const reopened = await applyPeriodReopenDecision(ctxFor(APPROVER_ACTOR_UUID), { decisionId: requested.decisionId, correlationId: applyCorrelationId }, deps);
    expect(reopened.status).toBe('open');
    expect(await getPeriod(period.id)).toEqual({ status: 'open', version: reopened.version });
    await assertOutboxEvent(applyCorrelationId, PERIOD_REOPENED_EVENT, period.id, PERIODS_AGGREGATE);

    // The CFO closes it again — the SAME decisionId is now a stale replay (its own recorded
    // periodVersion no longer matches), and a direct update by the SAME approver is refused too.
    const closedAgain = await closePeriod(ctxFor(CFO_ACTOR_UUID), { periodId: period.id, expectedVersion: reopened.version, correlationId: nextCorrelationId() }, deps);
    expect(closedAgain.status).toBe('closed');

    await expect(
      applyPeriodReopenDecision(ctxFor(APPROVER_ACTOR_UUID), { decisionId: requested.decisionId, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(StaleVersionError);
    expect((await getPeriod(period.id)).status).toBe('closed');

    let replayDirectUpdateRejection: unknown;
    try {
      // Version bumped correctly (finding #1) — isolates the refusal to the decision check alone.
      await withContext(ctxFor(APPROVER_ACTOR_UUID), async (tx: NodePgDatabase) =>
        tx.execute(sql`update billing.accounting_periods set status = 'open', version = version + 1 where id = ${period.id}`),
      );
    } catch (error) {
      replayDirectUpdateRejection = error;
    }
    expect(findRaisedException(replayDirectUpdateRejection, CHECK_VIOLATION)).toBeDefined();

    // Close review round 1 (VERIFY) finding #1: rolling the period's version BACK DOWN to the
    // decision's own recorded periodVersion (to try to defeat the stale-replay guard) is itself
    // refused by guard (a) (new.version < old.version -> 23514) — the rollback never happens, so
    // the version stays unchanged, and the SAME decision can never be replayed this way either.
    const versionBeforeRollbackAttempt = (await getPeriod(period.id)).version;
    await expect(
      pool.query(`update billing.accounting_periods set version = $2 where id = $1`, [period.id, closed.version]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await getPeriod(period.id)).version).toBe(versionBeforeRollbackAttempt);

    await expect(
      pool.query(`update billing.accounting_periods set status = 'open', version = version + 1 where id = $1`, [period.id]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  // Close review round 1 (VERIFY) finding #8: three more ways applyPeriodReopenDecision must
  // refuse — none of them ever changes the period, and none writes an outbox/audit row.
  it('applyPeriodReopenDecision refuses an unknown decision id, a decision still "open", and a "rejected" decision — each IllegalPeriodTransitionError, nothing written', async () => {
    const range = nextRange();
    const period = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...range });
    const closed = await closePeriod(ctxFor(CFO_ACTOR_UUID), { periodId: period.id, expectedVersion: period.version, correlationId: nextCorrelationId() }, deps);

    // (i) an unknown decision id.
    const unknownCorrelationId = nextCorrelationId();
    await expect(
      applyPeriodReopenDecision(ctxFor(APPROVER_ACTOR_UUID), { decisionId: randomUUID(), correlationId: unknownCorrelationId }, deps),
    ).rejects.toBeInstanceOf(IllegalPeriodTransitionError);
    expect((await getPeriod(period.id)).status).toBe('closed');
    await assertNoWriteForCorrelation(unknownCorrelationId);

    // (ii) a decision still 'open' (not yet decided).
    const requested = await requestReopenPeriod(ctxFor(PLAIN_ACTOR_UUID), { periodId: period.id, expectedVersion: closed.version, correlationId: nextCorrelationId() }, deps);
    insertedDecisionIds.push(requested.decisionId);
    const stillOpenCorrelationId = nextCorrelationId();
    await expect(
      applyPeriodReopenDecision(ctxFor(APPROVER_ACTOR_UUID), { decisionId: requested.decisionId, correlationId: stillOpenCorrelationId }, deps),
    ).rejects.toBeInstanceOf(IllegalPeriodTransitionError);
    expect((await getPeriod(period.id)).status).toBe('closed');
    await assertNoWriteForCorrelation(stillOpenCorrelationId);

    // (iii) a 'rejected' decision.
    await markDecisionDecided(requested.decisionId, APPROVER_ACTOR_UUID, 'rejected');
    const rejectedCorrelationId = nextCorrelationId();
    await expect(
      applyPeriodReopenDecision(ctxFor(APPROVER_ACTOR_UUID), { decisionId: requested.decisionId, correlationId: rejectedCorrelationId }, deps),
    ).rejects.toBeInstanceOf(IllegalPeriodTransitionError);
    expect((await getPeriod(period.id)).status).toBe('closed');
    await assertNoWriteForCorrelation(rejectedCorrelationId);
  });
});

// --- Scenario: Stale version is rejected; idempotent replay returns the first result ----------------

describe('Scenario: Stale version is rejected; idempotent replay returns the first result', () => {
  it('a stale expectedVersion is refused, nothing written', async () => {
    const range = nextRange();
    const period = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...range });
    const correlationId = nextCorrelationId();
    await expect(closePeriod(ctxFor(CFO_ACTOR_UUID), { periodId: period.id, expectedVersion: period.version + 999, correlationId }, deps)).rejects.toBeInstanceOf(
      StaleVersionError,
    );
    expect((await getPeriod(period.id)).status).toBe('open');
    await assertNoWriteForCorrelation(correlationId);
  });

  it('the same Idempotency-Key and body twice: the second call returns the identical result, version bumped exactly once', async () => {
    const range = nextRange();
    const period = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...range });
    const idempotencyKey = randomUUID();
    const correlationId = nextCorrelationId();
    const body = { periodId: period.id, expectedVersion: period.version, correlationId };
    const idem = idemFor('close-period', idempotencyKey, body);

    const first = await closePeriod(ctxFor(CFO_ACTOR_UUID), { ...body, idem }, deps);
    expect(first.status).toBe('closed');

    const second = await closePeriod(ctxFor(CFO_ACTOR_UUID), { ...body, idem }, deps);
    expect(second).toEqual(first);

    expect((await getPeriod(period.id)).version).toBe(period.version + 1);
    const outboxRows = await outboxRowsForCorrelationAndType(correlationId, PERIOD_CLOSED_EVENT);
    expect(outboxRows).toHaveLength(1);
  });
});

// --- Scenario: RLS — a caller scoped to another entity cannot see or change this entity's periods --

describe("Scenario: RLS — a caller scoped to another entity cannot see or change this entity's periods", () => {
  it('zero rows are visible from either table; an UPDATE attempt affects zero rows; both INSERT attempts are rejected by RLS; closePeriod reports not-found', async () => {
    const range = nextRange();
    const period = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...range });

    const periodsSeen = await withContext(ctxFor(OUTSIDER_ACTOR_UUID), async (tx: NodePgDatabase) => tx.execute<{ id: string }>(sql`select id from billing.accounting_periods where entity_id = ${entityId}`));
    expect(periodsSeen.rows).toHaveLength(0);

    const fiscalYearsSeen = await withContext(ctxFor(OUTSIDER_ACTOR_UUID), async (tx: NodePgDatabase) => tx.execute<{ id: string }>(sql`select id from billing.fiscal_years where entity_id = ${entityId}`));
    expect(fiscalYearsSeen.rows).toHaveLength(0);

    const updateResult = await withContext(ctxFor(OUTSIDER_ACTOR_UUID), async (tx: NodePgDatabase) => tx.execute(sql`update billing.accounting_periods set status = 'closed' where id = ${period.id}`));
    expect(updateResult.rowCount ?? 0).toBe(0);
    expect((await getPeriod(period.id)).status).toBe('open');

    let periodInsertRejection: unknown;
    try {
      await withContext(ctxFor(OUTSIDER_ACTOR_UUID), async (tx: NodePgDatabase) =>
        tx.execute(sql`insert into billing.accounting_periods (entity_id, fiscal_year_id, start_date, end_date) values (${entityId}, ${fiscalYearId}, '2001-01-01', '2001-01-31')`),
      );
    } catch (error) {
      periodInsertRejection = error;
    }
    expect(findRaisedException(periodInsertRejection, INSUFFICIENT_PRIVILEGE)).toBeDefined();

    let fiscalYearInsertRejection: unknown;
    try {
      await withContext(ctxFor(OUTSIDER_ACTOR_UUID), async (tx: NodePgDatabase) => tx.execute(sql`insert into billing.fiscal_years (entity_id, start_date, end_date) values (${entityId}, '2001-01-01', '2001-12-31')`));
    } catch (error) {
      fiscalYearInsertRejection = error;
    }
    expect(findRaisedException(fiscalYearInsertRejection, INSUFFICIENT_PRIVILEGE)).toBeDefined();

    // 4.19 pre-build review finding 17: RLS hides the row from the repository lookup entirely.
    await expect(
      closePeriod(ctxFor(OUTSIDER_ACTOR_UUID), { periodId: period.id, expectedVersion: period.version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(PeriodNotFoundError);
  });
});

// --- Scenario: SCR-ACC-01 #4 ------------------------------------------------------------------------

describe('Scenario: Design default (SCR-ACC-01 #4): a non-null period_id must be the actual covering period, else 23514', () => {
  it('a period_id that does not cover entry_date is refused, even though entry_date has its own (different, open) covering period', async () => {
    const rangeA = nextRange();
    const periodA = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...rangeA });
    const rangeB = nextRange();
    const periodB = await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...rangeB });

    await expect(insertJournalEntryAdmin({ forEntityId: entityId, entryDate: rangeB.startDate, periodId: periodA.id })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await getPeriod(periodB.id)).status).toBe('open');
  });

  it('an entry_date with NO covering period at all is accepted even with period_id left null (design item 3: "not refused by this slice")', async () => {
    const uncoveredDate = addDays(fyStart, MAIN_FY_LENGTH_DAYS - 2);
    const result = await insertJournalEntryAdmin({ forEntityId: entityId, entryDate: uncoveredDate });
    const id = result.rows[0]?.id;
    if (!id) throw new Error('expected the uncovered-date insert to succeed and return an id');
    insertedJournalEntryIds.push(id);
  });
});

// --- Scenario: Structural rules on fiscal_years and accounting_periods (D3/D4) -----------------------

describe('Scenario: Structural rules on fiscal_years and accounting_periods (D3/D4)', () => {
  // Close review round 1 (VERIFY) finding #3: the application layer maps each of these DB-level
  // structural refusals to its own typed error, not a raw Postgres error.
  it('createFiscalYear: an overlapping range for the SAME entity is refused as FiscalYearOverlapError (23P01 under the hood)', async () => {
    await expect(
      createFiscalYear(ctxFor(CFO_ACTOR_UUID), { entityId, startDate: fyStart, endDate: addDays(fyStart, 10), correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(FiscalYearOverlapError);
  });

  it('openPeriod: an overlapping range inside the same fiscal year is refused as PeriodOverlapError (23P01 under the hood)', async () => {
    const range = nextRange();
    await freshOpenPeriod({ forEntityId: entityId, forFiscalYearId: fiscalYearId, ...range });
    await expect(
      openPeriod(
        ctxFor(PLAIN_ACTOR_UUID),
        { entityId, fiscalYearId, startDate: range.startDate, endDate: addDays(range.endDate, 1), correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(PeriodOverlapError);
  });

  it('openPeriod: a range outside its own fiscal year is refused as PeriodOutsideFiscalYearError (23514 under the hood)', async () => {
    await expect(
      openPeriod(
        ctxFor(PLAIN_ACTOR_UUID),
        { entityId, fiscalYearId, startDate: addDays(fyStart, -10), endDate: addDays(fyStart, -1), correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(PeriodOutsideFiscalYearError);
  });

  it('createFiscalYear: a CFO not entity-scoped to the target entity is refused as EntityNotInScopeError (42501 under the hood)', async () => {
    await expect(
      createFiscalYear(
        ctxFor(CFO_ACTOR_UUID),
        { entityId: outsiderEntityId, startDate: addDays(fyStart, 5000), endDate: addDays(fyStart, 5030), correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(EntityNotInScopeError);
  });

  it('D3: two overlapping fiscal years of the SAME entity are refused (23P01)', async () => {
    await expect(
      pool.query(`insert into billing.fiscal_years (entity_id, start_date, end_date) values ($1, $2, $3)`, [
        entityId,
        addDays(structuralFyStart, 10),
        addDays(structuralFyStart, 40),
      ]),
    ).rejects.toMatchObject({ code: EXCLUSION_VIOLATION });
  });

  it('D3: two overlapping periods of the SAME entity, inside the same fiscal year, are refused (23P01)', async () => {
    const range = nextStructuralRange();
    await insertOpenPeriodAdmin({ forEntityId: entityId, forFiscalYearId: structuralFiscalYearId, ...range });
    const overlapStart = addDays(range.startDate, 2);
    const overlapEnd = addDays(range.endDate, 2);
    await expect(
      pool.query(`insert into billing.accounting_periods (entity_id, fiscal_year_id, start_date, end_date) values ($1, $2, $3, $4)`, [
        entityId,
        structuralFiscalYearId,
        overlapStart,
        overlapEnd,
      ]),
    ).rejects.toMatchObject({ code: EXCLUSION_VIOLATION });
  });

  it('D3: a period outside its own fiscal year range is refused (23514)', async () => {
    await expect(
      pool.query(`insert into billing.accounting_periods (entity_id, fiscal_year_id, start_date, end_date) values ($1, $2, $3, $4)`, [
        entityId,
        structuralFiscalYearId,
        addDays(structuralFyStart, -5),
        addDays(structuralFyStart, 5),
      ]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it("D3: a fiscal_year_id belonging to a DIFFERENT entity is refused (23503)", async () => {
    const range = nextStructuralRange();
    await expect(
      pool.query(`insert into billing.accounting_periods (entity_id, fiscal_year_id, start_date, end_date) values ($1, $2, $3, $4)`, [
        entityId,
        outsiderFiscalYearId,
        range.startDate,
        range.endDate,
      ]),
    ).rejects.toMatchObject({ code: FK_VIOLATION });
  });

  it('D3: start_date after end_date is refused (23514) for both fiscal_years and accounting_periods', async () => {
    await expect(
      pool.query(`insert into billing.fiscal_years (entity_id, start_date, end_date) values ($1, $2, $3)`, [
        entityId,
        addDays(structuralFyStart, STRUCTURAL_FY_LENGTH_DAYS + 100),
        addDays(structuralFyStart, STRUCTURAL_FY_LENGTH_DAYS + 50),
      ]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    const range = nextStructuralRange();
    await expect(
      pool.query(`insert into billing.accounting_periods (entity_id, fiscal_year_id, start_date, end_date) values ($1, $2, $3, $4)`, [
        entityId,
        structuralFiscalYearId,
        range.endDate,
        range.startDate,
      ]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it("D4: withContext UPDATE of a period's entity_id, fiscal_year_id, start_date, or end_date is refused (42501); withContext DELETE of a period is refused (42501)", async () => {
    const range = nextStructuralRange();
    const periodId = await insertOpenPeriodAdmin({ forEntityId: entityId, forFiscalYearId: structuralFiscalYearId, ...range });

    const columnUpdates: ReadonlyArray<{ column: 'entity_id' | 'fiscal_year_id' | 'start_date' | 'end_date'; value: string }> = [
      { column: 'entity_id', value: outsiderEntityId },
      { column: 'fiscal_year_id', value: outsiderFiscalYearId },
      { column: 'start_date', value: addDays(range.startDate, 1) },
      { column: 'end_date', value: addDays(range.endDate, -1) },
    ];
    for (const { column, value } of columnUpdates) {
      let rejection: unknown;
      try {
        await withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => tx.execute(sql`update billing.accounting_periods set ${sql.identifier(column)} = ${value} where id = ${periodId}`));
      } catch (error) {
        rejection = error;
      }
      expect(findRaisedException(rejection, INSUFFICIENT_PRIVILEGE)).toBeDefined();
    }

    let deleteRejection: unknown;
    try {
      await withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => tx.execute(sql`delete from billing.accounting_periods where id = ${periodId}`));
    } catch (error) {
      deleteRejection = error;
    }
    expect(findRaisedException(deleteRejection, INSUFFICIENT_PRIVILEGE)).toBeDefined();
  });

  it('D4: withContext UPDATE or DELETE of a fiscal_years row is refused (42501) — no update/delete grant at all', async () => {
    let updateRejection: unknown;
    try {
      await withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => tx.execute(sql`update billing.fiscal_years set start_date = start_date where id = ${structuralFiscalYearId}`));
    } catch (error) {
      updateRejection = error;
    }
    expect(findRaisedException(updateRejection, INSUFFICIENT_PRIVILEGE)).toBeDefined();

    let deleteRejection: unknown;
    try {
      await withContext(ctxFor(CFO_ACTOR_UUID), async (tx: NodePgDatabase) => tx.execute(sql`delete from billing.fiscal_years where id = ${structuralFiscalYearId}`));
    } catch (error) {
      deleteRejection = error;
    }
    expect(findRaisedException(deleteRejection, INSUFFICIENT_PRIVILEGE)).toBeDefined();
  });

  it("D4: the admin pool itself (bypassing every grant) still cannot change a period's start_date or end_date (23514) — a genuine trigger, not merely a grant", async () => {
    const range = nextStructuralRange();
    const periodId = await insertOpenPeriodAdmin({ forEntityId: entityId, forFiscalYearId: structuralFiscalYearId, ...range });

    await expect(pool.query(`update billing.accounting_periods set start_date = $2 where id = $1`, [periodId, addDays(range.startDate, 1)])).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    await expect(pool.query(`update billing.accounting_periods set end_date = $2 where id = $1`, [periodId, addDays(range.endDate, -1)])).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });

  it.each(['closed', 'locked'] as const)('D4: an admin-pool INSERT with status = %s (anything other than "open") is refused (23514)', async (status) => {
    const range = nextStructuralRange();
    await expect(
      pool.query(`insert into billing.accounting_periods (entity_id, fiscal_year_id, start_date, end_date, status) values ($1, $2, $3, $4, $5)`, [
        entityId,
        structuralFiscalYearId,
        range.startDate,
        range.endDate,
        status,
      ]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  // Close review round 1 (VERIFY) finding #1: the 0040 guard (a) — new.version < old.version, or
  // any status change whose new.version <> old.version + 1 — is a DISTINCT DB rule from the edge
  // table below, tested here directly, in isolation from any decision/edge concern.
  it('D4 guard (a): a version DECREASE is refused (23514); a status change whose version delta is not exactly +1 is refused (23514), even on an otherwise-legal edge', async () => {
    const range = nextStructuralRange();
    const periodId = await insertOpenPeriodAdmin({ forEntityId: entityId, forFiscalYearId: structuralFiscalYearId, ...range });
    await pool.query(`update billing.accounting_periods set status = 'closed', version = version + 1 where id = $1`, [periodId]); // legitimate open->closed.
    const afterClose = await getPeriod(periodId);

    await expect(
      pool.query(`update billing.accounting_periods set version = $2 where id = $1`, [periodId, afterClose.version - 1]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await getPeriod(periodId)).version).toBe(afterClose.version); // unchanged — the decrease was refused.

    // closed->locked is a LEGAL edge (D4), but a +2 version delta is refused by guard (a) alone.
    await expect(
      pool.query(`update billing.accounting_periods set status = 'locked', version = version + 2 where id = $1`, [periodId]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await getPeriod(periodId)).status).toBe('closed'); // unchanged — the bad-delta attempt was refused.
  });

  const EDGE_TABLE = [
    { from: 'open', to: 'open', allowed: true },
    { from: 'open', to: 'closed', allowed: true },
    { from: 'open', to: 'locked', allowed: false },
    { from: 'closed', to: 'open', allowed: false }, // admin pool: no session/decision context at all.
    { from: 'closed', to: 'closed', allowed: true },
    { from: 'closed', to: 'locked', allowed: true },
    { from: 'locked', to: 'open', allowed: false },
    { from: 'locked', to: 'closed', allowed: false },
    { from: 'locked', to: 'locked', allowed: true },
  ] as const;

  it.each(EDGE_TABLE)('D4: admin pool $from -> $to (expected allowed=$allowed)', async ({ from, to, allowed }) => {
    const range = nextStructuralRange();
    const periodId = await insertOpenPeriodAdmin({ forEntityId: entityId, forFiscalYearId: structuralFiscalYearId, ...range });
    await reachStatusViaAdmin(periodId, from);

    // Close review round 1 (VERIFY) finding #1: version bumped by exactly 1 on every attempt,
    // legal or not — isolates every refusal below to the (from, to) edge itself, never to guard
    // (a)'s own separate version-consistency check.
    if (allowed) {
      await pool.query(`update billing.accounting_periods set status = $2, version = version + 1 where id = $1`, [periodId, to]);
      expect((await getPeriod(periodId)).status).toBe(to);
    } else {
      await expect(
        pool.query(`update billing.accounting_periods set status = $2, version = version + 1 where id = $1`, [periodId, to]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
  });
});
