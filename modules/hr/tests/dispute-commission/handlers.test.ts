// modules/hr/tests/dispute-commission/handlers.test.ts — WBS 3.13 part 4.
//
// Exercises the api layer's contract (../../api/dispute-commission/handlers.ts) — one test per
// mapping, same 400/409/422/200/500 Problem-envelope discipline as this module's own
// calculate-daily-commission/handlers.test.ts precedent:
//   - a missing Idempotency-Key header -> 400 (CLAUDE.md · ARCHITECTURE: "Every write endpoint
//     requires an Idempotency-Key");
//   - a body that fails the Zod contract (empty disputeNote) -> 400;
//   - a replayed call with the same key but a DIFFERENT body -> 409 IdempotencyConflictError;
//   - a same key / same body replay -> 200, identical response, no second write;
//   - DisputeWindowExpiredError -> 409 (brief, Deliver's own final paragraph: "a real conflict, the
//     window closed");
//   - a missing ctx.userId -> 422 MissingActorError (cross-module convention);
//   - an unexpected thrown error -> 500, generic detail, logged through deps.logger.error (pino, no
//     console.log — CLAUDE.md · AGENT CONSTRAINTS).
//
// Fixture/RLS pattern: admin pool, one real identity.users row for the actor, plus a fixture
// hr.commission_daily row inserted directly via SQL — same convention as
// ./dispute-commission.test.ts. D-183: a DELETE against the shared database is only allowed in
// this suite's own `afterAll`, never in `beforeAll`.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';

import { createDisputeCommissionDeps } from '../../api/dispute-commission/composition.js';
import type { Logger } from '../../application/dispute-commission/ports.js';

// The module under test — built and GREEN.
import { handleDisputeCommission, type ApiRequest } from '../../api/dispute-commission/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const FIXTURE_ACTOR_UUID = '00000000-0000-4000-8000-0000003134c1';
// round-5 fix round, finding 2: an internal actor visible via hr.driver_commission.read_all
// (DEL_SUP), never linked to any employee — exercises the 403 CannotDisputeAnotherEmployeesRowError
// mapping at the handler level (distinct from every other 403/409/422 mapping already covered).
const READ_ALL_INTERNAL_ACTOR_UUID = '00000000-0000-4000-8000-0000003134c3';
const DEL_SUP_ROLE_CODE = 'DEL_SUP';

const NOW = new Date('2024-06-01T06:00:00.000Z');
const clock = new FixedClock(NOW);
const ids = new SequentialIdGenerator(31341);
const ctx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: true };

const DISPUTE_WINDOW_THRESHOLD_KEY = 'hr.commission.dispute_window_hours';
const HOURS_TO_MS = 60 * 60 * 1000;
const HTTP_STATUS_FORBIDDEN = 403;

let entityId: string;
const fixtureEmployeeIds: string[] = [];
const fixtureCommissionDailyIds: string[] = [];

async function grantRole(userId: string, roleCode: string): Promise<void> {
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [
    roleCode,
  ]);
  const roleId = roleResult.rows[0]?.id;
  if (!roleId) throw new Error(`identity.roles row not found for code ${roleCode}`);
  await pool.query(
    `insert into identity.user_roles (user_id, role_id) values ($1, $2) on conflict do nothing`,
    [userId, roleId],
  );
}

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
}

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

let employeeCodeCounter = 0;
function nextEmployeeCode(): string {
  const suffix = (400 + employeeCodeCounter++).toString();
  return `PG-7${suffix}`;
}

async function createFixtureEmployee(): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.employees (entity_id, code, name_ar, hire_date, status)
       values ($1, $2, $3, current_date, 'active') returning id::text as id`,
    [entityId, nextEmployeeCode(), 'موظف اختبار معالجات اعتراض العمولة — WBS 3.13 part 4'],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture hr.employees row');
  fixtureEmployeeIds.push(id);
  return id;
}

async function createFixtureCommissionDaily(params: {
  readonly employeeId: string;
  readonly workDate: string;
  readonly createdAt: Date;
}): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.commission_daily (entity_id, work_date, employee_id, source_snapshot, status, created_at)
       values ($1, $2, $3, '{}'::jsonb, 'calculated', $4)
       returning id::text as id`,
    [entityId, params.workDate, params.employeeId, params.createdAt.toISOString()],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture hr.commission_daily row');
  fixtureCommissionDailyIds.push(id);
  return id;
}

async function getDisputeWindowHours(): Promise<number> {
  const result: QueryResult<{ value: string }> = await pool.query(
    `select value::text as value from platform.thresholds where key = $1`,
    [DISPUTE_WINDOW_THRESHOLD_KEY],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `platform.thresholds row '${DISPUTE_WINDOW_THRESHOLD_KEY}' not found — is the pending migration ` +
        '(tasks/backlog/MIGRATION-REQUEST-3.md row 3) applied? (expected RED until it is)',
    );
  }
  return Number(row.value);
}

function validBody(commissionDailyId: string): Record<string, unknown> {
  return { commissionDailyId, disputeNote: 'اعتراض اختباري', correlationId: randomUUID() };
}

/** links FIXTURE_ACTOR_UUID's own identity.users row to `employeeId` — own_commission's SELECT
 *  policy gates visibility on `employee_id = platform.my_employee_id()` (this actor holds no
 *  read_all-class permission); every scenario that expects handleDisputeCommission to actually see
 *  the fixture row (i.e. every case that is not merely rejected before the DB read) must link it
 *  first, or the row reads back invisible and the command fails with StaleVersionError for the
 *  wrong reason (a pre-existing gap in this file, fixed here — same pattern as
 *  ../confirm-commission/handlers.test.ts's own setDisputingEmployee). */
async function setDisputingEmployee(employeeId: string): Promise<void> {
  await pool.query(`update identity.users set employee_id = $1 where id = $2`, [employeeId, FIXTURE_ACTOR_UUID]);
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) throw new Error(`fixture platform.entities row not found for code 'PST'`);
  entityId = entityRow.id;

  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [FIXTURE_ACTOR_UUID, `_hr_disputecommission_handlers_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات اعتراض العمولة'],
  );
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict do nothing`,
    [FIXTURE_ACTOR_UUID, entityId],
  );

  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type, employee_id)
       values ($1, $2, $3, 'internal', null)
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [
      READ_ALL_INTERNAL_ACTOR_UUID,
      `_hr_disputecommission_handlers_readall_${randomUUID()}@test.invalid`,
      'ممثل مشرف توصيل — معالجات اعتراض العمولة WBS 3.13 part 4',
    ],
  );
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict do nothing`,
    [READ_ALL_INTERNAL_ACTOR_UUID, entityId],
  );
  await grantRole(READ_ALL_INTERNAL_ACTOR_UUID, DEL_SUP_ROLE_CODE);
});

afterAll(async () => {
  if (fixtureCommissionDailyIds.length > 0) {
    await pool.query(`delete from hr.commission_daily where id = any($1::uuid[])`, [fixtureCommissionDailyIds]);
  }
  if (fixtureEmployeeIds.length > 0) {
    await pool.query(`delete from hr.commission_daily where employee_id = any($1::uuid[])`, [fixtureEmployeeIds]);
    await pool.query(`delete from hr.employees where id = any($1::uuid[])`, [fixtureEmployeeIds]);
  }
  for (const userId of [FIXTURE_ACTOR_UUID, READ_ALL_INTERNAL_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleDisputeCommission: no Idempotency-Key header -> 400', async () => {
    const employeeId = await createFixtureEmployee();
    await setDisputingEmployee(employeeId);
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-30',
      createdAt: new Date(NOW.getTime() - 1 * HOURS_TO_MS),
    });
    const deps = createDisputeCommissionDeps({ clock, ids });

    const result = await handleDisputeCommission(requestWithoutKey(validBody(commissionDailyId)), deps);
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('a body that fails the Zod contract is rejected with a 400 Problem', () => {
  it('handleDisputeCommission: an empty disputeNote -> 400', async () => {
    const deps = createDisputeCommissionDeps({ clock, ids });
    const body = { ...validBody(randomUUID()), disputeNote: '' };

    const result = await handleDisputeCommission(requestWithKey(body), deps);
    expect(result.status).toBe(400);
  });
});

describe('a replayed call with the same Idempotency-Key but a DIFFERENT body -> 409 IdempotencyConflictError', () => {
  it('handleDisputeCommission: same key, different commissionDailyId on the second call -> 409', async () => {
    const employeeIdA = await createFixtureEmployee();
    // linked to employeeIdA only — the second call below is refused by the idempotency-key
    // conflict check itself (a different body under the same key), which never needs to read rowB
    // at all, so FIXTURE_ACTOR_UUID (single actor, one employee_id link at a time) never needs to
    // see employeeIdB's own row.
    await setDisputingEmployee(employeeIdA);
    const rowA = await createFixtureCommissionDaily({
      employeeId: employeeIdA,
      workDate: '2024-05-30',
      createdAt: new Date(NOW.getTime() - 1 * HOURS_TO_MS),
    });
    const employeeIdB = await createFixtureEmployee();
    const rowB = await createFixtureCommissionDaily({
      employeeId: employeeIdB,
      workDate: '2024-05-30',
      createdAt: new Date(NOW.getTime() - 1 * HOURS_TO_MS),
    });
    const deps = createDisputeCommissionDeps({ clock, ids });
    const idempotencyKey = randomUUID();

    const first = await handleDisputeCommission(requestWithKey(validBody(rowA), idempotencyKey), deps);
    expect(first.status).toBe(200);

    const result = await handleDisputeCommission(requestWithKey(validBody(rowB), idempotencyKey), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });

  it('handleDisputeCommission: same key, same body on the second call -> 200, byte-identical response, exactly one write', async () => {
    const employeeId = await createFixtureEmployee();
    await setDisputingEmployee(employeeId);
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-30',
      createdAt: new Date(NOW.getTime() - 1 * HOURS_TO_MS),
    });
    const deps = createDisputeCommissionDeps({ clock, ids });
    const idempotencyKey = randomUUID();
    const body = validBody(commissionDailyId);

    const first = await handleDisputeCommission(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const second = await handleDisputeCommission(requestWithKey(body, idempotencyKey), deps);
    expect(second.status).toBe(200);
    expect(second).toEqual(first);

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from hr.commission_daily where id = $1 and status = 'disputed'`,
      [commissionDailyId],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(1);
  });
});

describe(
  'round-5 fix round, finding 2: an internal read_all-only actor disputing a DIFFERENT employee\'s ' +
    'row maps to a 403 Problem titled CannotDisputeAnotherEmployeesRowError',
  () => {
    it('handleDisputeCommission: READ_ALL_INTERNAL_ACTOR_UUID disputing a DIFFERENT employee\'s row -> 403, no write', async () => {
      const employeeId = await createFixtureEmployee();
      // deliberately NOT linked to READ_ALL_INTERNAL_ACTOR_UUID — this employee's row belongs to a
      // DIFFERENT actor entirely (FIXTURE_ACTOR_UUID's own setDisputingEmployee is never called for
      // this employeeId, and READ_ALL_INTERNAL_ACTOR_UUID's own employee_id stays permanently null).
      const commissionDailyId = await createFixtureCommissionDaily({
        employeeId,
        workDate: '2024-05-30',
        createdAt: new Date(NOW.getTime() - 1 * HOURS_TO_MS),
      });
      const deps = createDisputeCommissionDeps({ clock, ids });

      const request: ApiRequest<Record<string, unknown>> = {
        headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() },
        body: validBody(commissionDailyId),
        ctx: { userId: READ_ALL_INTERNAL_ACTOR_UUID, clientId: null, isInternal: true },
      };

      const result = await handleDisputeCommission(request, deps);

      expect(result.status).toBe(HTTP_STATUS_FORBIDDEN);
      expect(result.body).toMatchObject({ title: 'CannotDisputeAnotherEmployeesRowError' });

      const countResult: QueryResult<{ n: string }> = await pool.query(
        `select count(*)::text as n from hr.commission_daily where id = $1 and status = 'disputed'`,
        [commissionDailyId],
      );
      expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
    });
  },
);

describe('a dispute past the 48-hour window maps to a 409 Problem titled DisputeWindowExpiredError', () => {
  it('handleDisputeCommission: a row created past the window -> 409, no write', async () => {
    const thresholdHours = await getDisputeWindowHours();
    const employeeId = await createFixtureEmployee();
    await setDisputingEmployee(employeeId);
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-28',
      createdAt: new Date(NOW.getTime() - (thresholdHours + 1) * HOURS_TO_MS),
    });
    const deps = createDisputeCommissionDeps({ clock, ids });

    const result = await handleDisputeCommission(requestWithKey(validBody(commissionDailyId)), deps);

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'DisputeWindowExpiredError' });

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from hr.commission_daily where id = $1 and status = 'disputed'`,
      [commissionDailyId],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
  });
});

describe('a missing ctx.userId maps to a 422 Problem titled MissingActorError (cross-module convention)', () => {
  it('handleDisputeCommission: ctx.userId is null -> 422, title "MissingActorError", no write', async () => {
    const employeeId = await createFixtureEmployee();
    await setDisputingEmployee(employeeId);
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-30',
      createdAt: new Date(NOW.getTime() - 1 * HOURS_TO_MS),
    });
    const deps = createDisputeCommissionDeps({ clock, ids });
    const noActorCtx = { userId: null, clientId: null, isInternal: true };

    const request: ApiRequest<Record<string, unknown>> = {
      headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() },
      body: validBody(commissionDailyId),
      ctx: noActorCtx,
    };

    const result = await handleDisputeCommission(request, deps);

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'MissingActorError' });
  });
});

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleDisputeCommission: an unexpected repository failure -> 500, generic detail, logger.error receives { correlationId, err: <the Error object> }', async () => {
    const employeeId = await createFixtureEmployee();
    await setDisputingEmployee(employeeId);
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-30',
      createdAt: new Date(NOW.getTime() - 1 * HOURS_TO_MS),
    });
    const logger = spyLogger();
    const baseDeps = createDisputeCommissionDeps({ clock, ids, logger });
    const thrown = new TypeError('unexpected repository failure — never sent to the client');
    const brokenDeps = {
      ...baseDeps,
      repo: {
        ...(baseDeps as unknown as { repo: Record<string, unknown> }).repo,
        updateToDisputed: async (): Promise<never> => {
          throw thrown;
        },
      },
    };
    const body = validBody(commissionDailyId);
    const correlationId = body['correlationId'] as string;

    const result = await handleDisputeCommission(
      requestWithKey(body),
      brokenDeps as unknown as typeof baseDeps,
    );

    expect(result.status).toBe(500);
    expect('body' in result ? JSON.stringify(result.body) : '').not.toMatch(/unexpected repository failure/);

    expect(logger.errorCalls).toHaveLength(1);
    const [loggedObj] = logger.errorCalls[0] as [Record<string, unknown>, string];
    expect(loggedObj['correlationId']).toBe(correlationId);
    expect(loggedObj['err']).toBeInstanceOf(Error);
    expect(loggedObj['err']).toBe(thrown);
  });
});
