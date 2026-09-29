// modules/billing/tests/accounting-periods/handlers.test.ts — WBS 4.19 (lane 2).
//
// The api layer's contract (modules/billing/api/accounting-periods/handlers.ts) — one handler per
// FROZEN contract route (packages/contracts/billing/accounting-periods.ts's own ROUTES array),
// so this file exercises all 5: handleCreateFiscalYear, handleOpenPeriod, handleClosePeriod,
// handleLockPeriod, handleReopenPeriod. Same api-mapping discipline as the golden slice's own
// modules/wms/tests/receive-inbound/handlers.test.ts: missing Idempotency-Key -> 400, invalid body
// -> 400, StaleVersionError -> 409, RoleRequiredError -> 403, IllegalPeriodTransitionError -> 422,
// title = error.name, and idempotent replay returns the identical response. Business-rule depth
// (RLS, per-entity isolation, the Decision Inbox flow, the DB-side constraint trigger) is already
// covered end-to-end by ./accounting-periods.test.ts — this file only proves the HANDLER's own
// mapping layer.
//
// 4.19 pre-build review D2 (final): createFiscalYear, closePeriod and lockPeriod are ALL CFO
// role-gated (403 RoleRequiredError for anyone else); openPeriod and requestReopenPeriod carry no
// role gate (4.19 pre-build review finding 9, 10 — cited by id, never "brief item n"/OD-12).
//
// Isolation (4.19 pre-build review finding 1): this file picks its OWN synthetic fiscal year,
// strictly after any synthetic year a previous integration file in this run already used — MUST be
// run with `PGDATABASE=pgeos_lane2` exported in the same shell command (the session default
// `pgeos` carries neither this lane's fixtures nor its own tests/dimensions baseline). Close review
// round 1 (VERIFY) finding #6: afterAll force-deletes every row this file itself recorded in one
// admin transaction under `session_replication_role = replica` — nothing is ever left as residue.
//
// STATUS: GREEN against pgeos_lane2 (database/migrations/0040_2_accounting-periods.sql applied).
//
// Handler surface this file exercises — modules/billing/api/accounting-periods/handlers.ts:
//   handleCreateFiscalYear, handleOpenPeriod, handleClosePeriod, handleLockPeriod,
//   handleReopenPeriod — each `(request: ApiRequest<TBody>, deps: AccountingPeriodsDeps) =>
//   Promise<{ status: number; body?: unknown }>`, same shape as the golden slice's own
//   handleApproveInbound et al.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock } from '@pg-eos/domain-kit';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';

import type { Logger } from '../../application/accounting-periods/ports.js';
import { createAccountingPeriodsDeps } from '../../api/accounting-periods/composition.js';
import {
  handleClosePeriod,
  handleCreateFiscalYear,
  handleLockPeriod,
  handleOpenPeriod,
  handleReopenPeriod,
  type ApiRequest,
} from '../../api/accounting-periods/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const CFO_ROLE_CODE = 'CFO';
const CFO_ACTOR_UUID = '00000000-0000-4000-8000-0000000419d1';
const PLAIN_ACTOR_UUID = '00000000-0000-4000-8000-0000000419d2';

const SYNTHETIC_YEAR_FLOOR = 1899;
const SYNTHETIC_YEAR_CUTOFF = '1950-01-01';
const FY_LENGTH_DAYS = 300;
const PERIOD_LENGTH_DAYS = 14;
const PERIOD_GAP_DAYS = 2;

const clock = new FixedClock(new Date('2026-09-28T00:00:00.000Z'));
const deps = createAccountingPeriodsDeps({ clock });
const cfoCtx = { userId: CFO_ACTOR_UUID, clientId: null, isInternal: true };
const plainCtx = { userId: PLAIN_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let outsiderEntityId: string;
let fiscalYearId: string;
let fyStart: string;
let fyEnd: string;
const insertedFiscalYearIds: string[] = [];
const insertedPeriodIds: string[] = [];
const insertedDecisionIds: string[] = [];

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** 4.19 pre-build review finding 2: each call takes the next distinct non-overlapping range in
 *  the file's own fiscal-year window. */
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

async function pickSyntheticYear(forEntityId: string): Promise<number> {
  const result: QueryResult<{ year: number }> = await pool.query(
    `select coalesce(max(extract(year from end_date))::int, $2) + 1 as year
       from billing.fiscal_years where entity_id = $1::uuid and end_date < $3::date`,
    [forEntityId, SYNTHETIC_YEAR_FLOOR, SYNTHETIC_YEAR_CUTOFF],
  );
  const year = result.rows[0]?.year;
  if (year === undefined) throw new Error('pickSyntheticYear: query returned no row');
  return year;
}

function requestWithKey<TBody>(body: TBody, ctx: typeof cfoCtx, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx };
}

function requestWithoutKey<TBody>(body: TBody, ctx: typeof cfoCtx): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
}

async function assignCfoRole(userId: string): Promise<void> {
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [CFO_ROLE_CODE]);
  const roleRow = roleResult.rows[0];
  if (!roleRow) throw new Error(`identity.roles row not found for code '${CFO_ROLE_CODE}'`);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2) on conflict do nothing`, [userId, roleRow.id]);
}

async function createFixtureActor(userId: string): Promise<void> {
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')
     on conflict (id) do update set email = excluded.email`,
    [userId, `_accper_handlers_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات الفترات — WBS 4.19'],
  );
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict do nothing`, [userId, entityId]);
}

async function freshOpenPeriodViaHandler(): Promise<{ id: string; version: number }> {
  const range = nextRange();
  const result = await handleOpenPeriod(requestWithKey({ entityId, fiscalYearId, ...range, correlationId: randomUUID() }, cfoCtx), deps);
  if (result.status !== 200) throw new Error(`fixture handleOpenPeriod did not return 200: ${JSON.stringify(result)}`);
  const body = result.body as { id: string; version: number };
  insertedPeriodIds.push(body.id);
  return body;
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

  await createFixtureActor(CFO_ACTOR_UUID);
  await assignCfoRole(CFO_ACTOR_UUID);
  await createFixtureActor(PLAIN_ACTOR_UUID);

  const year = await pickSyntheticYear(entityId);
  fyStart = `${year}-01-01`;
  fyEnd = addDays(fyStart, FY_LENGTH_DAYS - 1);
  nextRange = makeRangeAllocator(fyStart);

  const fyResult: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.fiscal_years (entity_id, start_date, end_date) values ($1, $2, $3) returning id`,
    [entityId, fyStart, fyEnd],
  );
  const fyRow = fyResult.rows[0];
  if (!fyRow) throw new Error('fixture billing.fiscal_years insert returned no id');
  fiscalYearId = fyRow.id;
  insertedFiscalYearIds.push(fiscalYearId);
});

afterAll(async () => {
  // Close review round 1 (VERIFY) finding #6: force-delete every row this file itself recorded —
  // decisions, periods, fiscal years — in ONE admin transaction under `session_replication_role =
  // replica` (bypasses the closed/locked-posting and immutable-column triggers — safe here because
  // these are this file's OWN tracked rows). Never platform.outbox or platform.audit_log
  // (append-only ledgers, D-183) — nothing here writes to either. Replaces the older "leave it as
  // documented residue" discipline (4.19 pre-build review finding 16 order preserved: decisions
  // before periods before fiscal years).
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local session_replication_role = replica`);
    if (insertedDecisionIds.length > 0) {
      await client.query(`delete from platform.decisions where id = any($1::uuid[])`, [insertedDecisionIds]);
    }
    if (insertedPeriodIds.length > 0) {
      await client.query(`delete from billing.accounting_periods where id = any($1::uuid[])`, [insertedPeriodIds]);
    }
    if (insertedFiscalYearIds.length > 0) {
      await client.query(`delete from billing.fiscal_years where id = any($1::uuid[])`, [insertedFiscalYearIds]);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error; // a genuine cleanup failure must be visible, never silently swallowed.
  } finally {
    client.release();
  }

  await pool.query(`delete from platform.idempotency_keys where user_id = any($1::uuid[])`, [[CFO_ACTOR_UUID, PLAIN_ACTOR_UUID]]);
  await pool.query(`delete from identity.user_roles where user_id = any($1::uuid[])`, [[CFO_ACTOR_UUID, PLAIN_ACTOR_UUID]]);
  await pool.query(`delete from identity.user_entities where user_id = any($1::uuid[])`, [[CFO_ACTOR_UUID, PLAIN_ACTOR_UUID]]);
  await pool.query(`delete from identity.users where id = any($1::uuid[])`, [[CFO_ACTOR_UUID, PLAIN_ACTOR_UUID]]);
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem, for every write route', () => {
  it('handleCreateFiscalYear', async () => {
    const nextFyStart = addDays(fyEnd, 30);
    const result = await handleCreateFiscalYear(
      requestWithoutKey({ entityId, startDate: nextFyStart, endDate: addDays(nextFyStart, 60), correlationId: randomUUID() }, cfoCtx),
      deps,
    );
    expect(result.status).toBe(400);
  });

  it('handleOpenPeriod', async () => {
    const range = nextRange();
    const result = await handleOpenPeriod(requestWithoutKey({ entityId, fiscalYearId, ...range, correlationId: randomUUID() }, cfoCtx), deps);
    expect(result.status).toBe(400);
  });

  it('handleClosePeriod', async () => {
    const result = await handleClosePeriod(requestWithoutKey({ periodId: randomUUID(), expectedVersion: 1, correlationId: randomUUID() }, cfoCtx), deps);
    expect(result.status).toBe(400);
  });

  it('handleLockPeriod', async () => {
    const result = await handleLockPeriod(requestWithoutKey({ periodId: randomUUID(), expectedVersion: 1, correlationId: randomUUID() }, cfoCtx), deps);
    expect(result.status).toBe(400);
  });

  it('handleReopenPeriod', async () => {
    const result = await handleReopenPeriod(requestWithoutKey({ periodId: randomUUID(), expectedVersion: 1, correlationId: randomUUID() }, plainCtx), deps);
    expect(result.status).toBe(400);
  });
});

describe('an invalid body is rejected with a 400 Problem', () => {
  it('handleCreateFiscalYear: a body missing required fields -> 400, not a thrown exception', async () => {
    const result = await handleCreateFiscalYear(requestWithKey({}, cfoCtx), deps);
    expect(result.status).toBe(400);
  });
});

describe('every 5 contract routes: the happy path returns 200; D2 CFO gates map to 403 title "RoleRequiredError"', () => {
  it('handleCreateFiscalYear: 200 as CFO; 403 for a non-CFO caller, nothing written', async () => {
    const nextFyStart = addDays(fyEnd, 30);
    const forbidden = await handleCreateFiscalYear(
      requestWithKey({ entityId, startDate: nextFyStart, endDate: addDays(nextFyStart, 60), correlationId: randomUUID() }, plainCtx),
      deps,
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toMatchObject({ title: 'RoleRequiredError' });

    const result = await handleCreateFiscalYear(
      requestWithKey({ entityId, startDate: nextFyStart, endDate: addDays(nextFyStart, 60), correlationId: randomUUID() }, cfoCtx),
      deps,
    );
    expect(result.status).toBe(200);
    insertedFiscalYearIds.push((result.body as { id: string }).id);
  });

  it('handleOpenPeriod -> 200 (D2: no role gate — the plain actor succeeds too)', async () => {
    const period = await freshOpenPeriodViaHandler();
    expect(period.version).toBe(1);

    const range = nextRange();
    const asPlain = await handleOpenPeriod(requestWithKey({ entityId, fiscalYearId, ...range, correlationId: randomUUID() }, plainCtx), deps);
    expect(asPlain.status).toBe(200);
    insertedPeriodIds.push((asPlain.body as { id: string }).id);
  });

  it('handleClosePeriod (as CFO) -> 200; as a non-CFO caller -> 403, title "RoleRequiredError"', async () => {
    const period = await freshOpenPeriodViaHandler();

    const forbidden = await handleClosePeriod(requestWithKey({ periodId: period.id, expectedVersion: period.version, correlationId: randomUUID() }, plainCtx), deps);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toMatchObject({ title: 'RoleRequiredError' });

    const result = await handleClosePeriod(requestWithKey({ periodId: period.id, expectedVersion: period.version, correlationId: randomUUID() }, cfoCtx), deps);
    expect(result.status).toBe(200);
  });

  it('handleLockPeriod: locking a still-OPEN period -> 422, title "IllegalPeriodTransitionError"; a non-CFO caller -> 403; locking after close (as CFO) -> 200', async () => {
    const period = await freshOpenPeriodViaHandler();

    const illegal = await handleLockPeriod(requestWithKey({ periodId: period.id, expectedVersion: period.version, correlationId: randomUUID() }, cfoCtx), deps);
    expect(illegal.status).toBe(422);
    expect(illegal.body).toMatchObject({ title: 'IllegalPeriodTransitionError' });

    const closed = await handleClosePeriod(requestWithKey({ periodId: period.id, expectedVersion: period.version, correlationId: randomUUID() }, cfoCtx), deps);
    const closedVersion = (closed.body as { version: number }).version;

    // 4.19 pre-build review finding 9: a non-CFO caller is refused, nothing written.
    const forbidden = await handleLockPeriod(requestWithKey({ periodId: period.id, expectedVersion: closedVersion, correlationId: randomUUID() }, plainCtx), deps);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toMatchObject({ title: 'RoleRequiredError' });
    const stillClosedRow: QueryResult<{ status: string }> = await pool.query(`select status from billing.accounting_periods where id = $1`, [period.id]);
    expect(stillClosedRow.rows[0]?.status).toBe('closed');

    const locked = await handleLockPeriod(requestWithKey({ periodId: period.id, expectedVersion: closedVersion, correlationId: randomUUID() }, cfoCtx), deps);
    expect(locked.status).toBe(200);
  });

  it('handleReopenPeriod (any caller, no CFO gate) -> 200, files a decision, period stays closed', async () => {
    const period = await freshOpenPeriodViaHandler();
    const closed = await handleClosePeriod(requestWithKey({ periodId: period.id, expectedVersion: period.version, correlationId: randomUUID() }, cfoCtx), deps);
    const closedVersion = (closed.body as { version: number }).version;

    const reopenResult = await handleReopenPeriod(requestWithKey({ periodId: period.id, expectedVersion: closedVersion, correlationId: randomUUID() }, plainCtx), deps);
    expect(reopenResult.status).toBe(200);
    const decisionId = (reopenResult.body as { decisionId?: string } | undefined)?.decisionId;
    expect(typeof decisionId).toBe('string');
    if (decisionId) insertedDecisionIds.push(decisionId);

    const periodRow: QueryResult<{ status: string }> = await pool.query(`select status from billing.accounting_periods where id = $1`, [period.id]);
    expect(periodRow.rows[0]?.status).toBe('closed');
  });
});

describe('StaleVersionError maps to 409, title = error.name', () => {
  it('handleClosePeriod: a stale expectedVersion -> 409, title "StaleVersionError"', async () => {
    const period = await freshOpenPeriodViaHandler();
    const result = await handleClosePeriod(requestWithKey({ periodId: period.id, expectedVersion: period.version + 999, correlationId: randomUUID() }, cfoCtx), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'StaleVersionError' });
  });
});

describe('idempotent replay: the same Idempotency-Key and body twice returns the identical response', () => {
  it('handleClosePeriod: identical key + body -> identical response, version bumped exactly once', async () => {
    const period = await freshOpenPeriodViaHandler();
    const idempotencyKey = randomUUID();
    const body = { periodId: period.id, expectedVersion: period.version, correlationId: randomUUID() };

    const first = await handleClosePeriod(requestWithKey(body, cfoCtx, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const second = await handleClosePeriod(requestWithKey(body, cfoCtx, idempotencyKey), deps);
    expect(second).toEqual(first);

    const periodRow: QueryResult<{ version: number }> = await pool.query(`select version from billing.accounting_periods where id = $1`, [period.id]);
    expect(periodRow.rows[0]?.version).toBe(period.version + 1); // bumped once, not twice.
  });
});

// --- Close review round 1 (VERIFY) finding #3: every new 422 mapping in (c), plus PeriodNotFound / ---
// --- FiscalYearNotFound, which "(c)" also names -----------------------------------------------------

describe('new typed errors from (c) map to 422, title = error.name', () => {
  it('handleCreateFiscalYear: an overlapping range for the SAME entity -> 422, title "FiscalYearOverlapError"', async () => {
    const result = await handleCreateFiscalYear(requestWithKey({ entityId, startDate: fyStart, endDate: addDays(fyStart, 10), correlationId: randomUUID() }, cfoCtx), deps);
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'FiscalYearOverlapError' });
  });

  it('handleOpenPeriod: an overlapping range inside the same fiscal year -> 422, title "PeriodOverlapError"', async () => {
    const range = nextRange();
    const created = await handleOpenPeriod(requestWithKey({ entityId, fiscalYearId, ...range, correlationId: randomUUID() }, cfoCtx), deps);
    expect(created.status).toBe(200);
    insertedPeriodIds.push((created.body as { id: string }).id);

    const overlapping = await handleOpenPeriod(
      requestWithKey({ entityId, fiscalYearId, startDate: range.startDate, endDate: addDays(range.endDate, 1), correlationId: randomUUID() }, cfoCtx),
      deps,
    );
    expect(overlapping.status).toBe(422);
    expect(overlapping.body).toMatchObject({ title: 'PeriodOverlapError' });
  });

  it('handleOpenPeriod: a range outside its own fiscal year -> 422, title "PeriodOutsideFiscalYearError"', async () => {
    const result = await handleOpenPeriod(
      requestWithKey({ entityId, fiscalYearId, startDate: addDays(fyStart, -10), endDate: addDays(fyStart, -1), correlationId: randomUUID() }, cfoCtx),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'PeriodOutsideFiscalYearError' });
  });

  it('handleCreateFiscalYear: a CFO not entity-scoped to the target entity -> 422, title "EntityNotInScopeError"', async () => {
    const result = await handleCreateFiscalYear(
      requestWithKey({ entityId: outsiderEntityId, startDate: addDays(fyEnd, 5000), endDate: addDays(fyEnd, 5100), correlationId: randomUUID() }, cfoCtx),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'EntityNotInScopeError' });
  });

  it('handleClosePeriod: a nonexistent periodId -> 422, title "PeriodNotFoundError"', async () => {
    const result = await handleClosePeriod(requestWithKey({ periodId: randomUUID(), expectedVersion: 1, correlationId: randomUUID() }, cfoCtx), deps);
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'PeriodNotFoundError' });
  });

  it('handleOpenPeriod: a nonexistent fiscalYearId -> 422, title "FiscalYearNotFoundError"', async () => {
    const range = nextRange();
    const result = await handleOpenPeriod(requestWithKey({ entityId, fiscalYearId: randomUUID(), ...range, correlationId: randomUUID() }, cfoCtx), deps);
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'FiscalYearNotFoundError' });
  });
});

// --- Close review round 1 (VERIFY) finding #9: the golden cases (modules/wms/tests/receive-inbound/ -
// --- handlers.test.ts:267, 337, 488) — this use case's own equivalents ------------------------------

describe('IdempotencyConflictError maps to 409, title = error.name', () => {
  it('handleClosePeriod: the same Idempotency-Key with a DIFFERENT body -> 409, title "IdempotencyConflictError"', async () => {
    const period = await freshOpenPeriodViaHandler();
    const idempotencyKey = randomUUID();
    const body = { periodId: period.id, expectedVersion: period.version, correlationId: randomUUID() };

    const first = await handleClosePeriod(requestWithKey(body, cfoCtx, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const differentBody = { periodId: period.id, expectedVersion: period.version, correlationId: randomUUID() };
    const result = await handleClosePeriod(requestWithKey(differentBody, cfoCtx, idempotencyKey), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });
});

function spyLogger(): Logger & { readonly errorCalls: Array<[Record<string, unknown>, string]> } {
  const errorCalls: Array<[Record<string, unknown>, string]> = [];
  return {
    errorCalls,
    error: (obj, msg) => {
      errorCalls.push([obj, msg]);
    },
    info: () => {
      // not asserted here.
    },
  };
}

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleClosePeriod: an unexpected repository failure -> 500, generic detail, logger.error receives { correlationId, err: <the Error object> }', async () => {
    const period = await freshOpenPeriodViaHandler();
    const logger = spyLogger();
    const depsWithSpyLogger = createAccountingPeriodsDeps({ clock, logger });
    const thrown = new TypeError('unexpected repository failure — never sent to the client');
    const brokenDeps = {
      ...depsWithSpyLogger,
      repo: {
        ...depsWithSpyLogger.repo,
        getPeriodForUpdate: async (): Promise<never> => {
          throw thrown;
        },
      },
    };
    const correlationId = randomUUID();

    const result = await handleClosePeriod(requestWithKey({ periodId: period.id, expectedVersion: period.version, correlationId }, cfoCtx), brokenDeps);

    expect(result.status).toBe(500);
    expect('body' in result ? JSON.stringify(result.body) : '').not.toMatch(/unexpected repository failure/);

    expect(logger.errorCalls).toHaveLength(1);
    const [loggedObj] = logger.errorCalls[0] as [Record<string, unknown>, string];
    expect(loggedObj['correlationId']).toBe(correlationId);
    expect(loggedObj['err']).toBeInstanceOf(Error);
    expect(loggedObj['err']).toBe(thrown);
  });
});
