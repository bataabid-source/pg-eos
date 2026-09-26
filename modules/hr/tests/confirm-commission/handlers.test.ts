// modules/hr/tests/confirm-commission/handlers.test.ts — WBS 3.13 part 4.
//
// Exercises the api layer's contract (../../api/confirm-commission/handlers.ts) — one test per
// mapping, same Problem-envelope discipline as this module's own calculate-daily-commission/
// handlers.test.ts and ../dispute-commission/handlers.test.ts precedents:
//   - a missing Idempotency-Key header -> 400;
//   - a body that fails the Zod contract (non-uuid commissionDailyId) -> 400;
//   - a replayed call with the same key but a DIFFERENT body -> 409 IdempotencyConflictError;
//   - a same key / same body replay -> 200, identical response, no second write;
//   - SelfReviewNotAllowedError -> 403 (brief, Deliver's own final paragraph: "SoD, the actor lacks
//     the privilege to act on their own row this way" — a LOCAL status constant, not imported from
//     the frozen packages/contracts/_shared/problem.ts PROBLEM_STATUS, same "define locally, do not
//     touch the frozen shared envelope" discipline this file's own sibling handlers.ts already uses
//     for HTTP_STATUS_OK/HTTP_STATUS_INTERNAL_SERVER_ERROR);
//   - DisputeWindowStillOpenError -> 409 (a real conflict — the window has not yet closed);
//   - a missing ctx.userId -> 422 MissingActorError (cross-module convention);
//   - an unexpected thrown error -> 500, generic detail, logged through deps.logger.error.
//
// Fixture/RLS pattern: admin pool, real identity.users rows for the DEL_SUP actor and the
// disputing driver actor, hr.commission_daily fixture rows inserted directly via SQL — same
// convention as ./confirm-commission.test.ts. D-183: a DELETE against the shared database is only
// allowed in this suite's own `afterAll`, never in `beforeAll`.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';

import { createConfirmCommissionDeps } from '../../api/confirm-commission/composition.js';
import type { Logger } from '../../application/confirm-commission/ports.js';

// The module under test — built and GREEN.
import { handleConfirmCommission, type ApiRequest } from '../../api/confirm-commission/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const DEL_SUP_ACTOR_UUID = '00000000-0000-4000-8000-0000003135c1';
const DISPUTING_DRIVER_ACTOR_UUID = '00000000-0000-4000-8000-0000003135c2';
// round-5 fix round, finding 4: holds hr.driver_commission.read_all (via SALES_MGR, migration 0033)
// but NOT hr.commission.confirm — same split as ../confirm-commission.test.ts's own
// READ_ALL_ONLY_ACTOR_UUID, needed here to exercise the handler-level 403 mapping for
// ConfirmPermissionRequiredError specifically (distinct from SelfReviewNotAllowedError, also 403).
const READ_ALL_ONLY_ACTOR_UUID = '00000000-0000-4000-8000-0000003135c3';
const DEL_SUP_ROLE_CODE = 'DEL_SUP';
const SALES_MGR_ROLE_CODE = 'SALES_MGR';

const NOW = new Date('2024-06-01T06:00:00.000Z');
const clock = new FixedClock(NOW);
const ids = new SequentialIdGenerator(31351);
const delSupCtx = { userId: DEL_SUP_ACTOR_UUID, clientId: null, isInternal: true };

const DISPUTE_WINDOW_THRESHOLD_KEY = 'hr.commission.dispute_window_hours';
const HOURS_TO_MS = 60 * 60 * 1000;
const HTTP_STATUS_FORBIDDEN = 403;

let entityId: string;
const fixtureEmployeeIds: string[] = [];
const fixtureCommissionDailyIds: string[] = [];

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx: delSupCtx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx: delSupCtx };
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

let employeeCodeCounter = 0;
function nextEmployeeCode(): string {
  const suffix = (600 + employeeCodeCounter++).toString();
  return `PG-7${suffix}`;
}

async function createFixtureEmployee(): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.employees (entity_id, code, name_ar, hire_date, status)
       values ($1, $2, $3, current_date, 'active') returning id::text as id`,
    [entityId, nextEmployeeCode(), 'موظف اختبار معالجات تأكيد العمولة — WBS 3.13 part 4'],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture hr.employees row');
  fixtureEmployeeIds.push(id);
  return id;
}

// migration 0033 round-4 review finding 2: an INSERT must start 'calculated' — a row that needs to
// START 'disputed' is built in two steps: INSERT as 'calculated', then a bare UPDATE to 'disputed'
// (a legal, ungated calculated -> disputed transition). See
// ../confirm-commission/confirm-commission.test.ts's own createFixtureCommissionDaily for the full
// rationale, copied verbatim here.
//
// pre-migration review round 1 (FAIL, 7 findings), finding 1: once migration 0035 lands, this same
// calculated -> disputed edge gains an EXISTS check requiring platform.current_user_id() to resolve
// to the row's own employee's own linked user — a bare admin-pool UPDATE with no session actor set
// would then fail with insufficient_privilege. Most callers in this file never called
// setDisputingEmployee before requesting a 'disputed' fixture row (only one test did, for its own
// unrelated reason) — this helper now links DISPUTING_DRIVER_ACTOR_UUID to `employeeId` itself (via
// setDisputingEmployee, idempotent if a caller already did it) and runs the UPDATE inside a
// dedicated `pool.connect()` client with a TRANSACTION-LOCAL `set_config('app.user_id', ..., true)`
// scoped to DISPUTING_DRIVER_ACTOR_UUID — same discipline as packages/db/src/with-context.ts.
async function createFixtureCommissionDaily(params: {
  readonly employeeId: string;
  readonly workDate: string;
  readonly createdAt: Date;
  readonly status: 'calculated' | 'disputed';
}): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.commission_daily
        (entity_id, work_date, employee_id, source_snapshot, status, created_at)
       values ($1, $2, $3, '{}'::jsonb, 'calculated', $4)
       returning id::text as id`,
    [entityId, params.workDate, params.employeeId, params.createdAt.toISOString()],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture hr.commission_daily row');
  fixtureCommissionDailyIds.push(id);

  if (params.status === 'disputed') {
    await setDisputingEmployee(params.employeeId);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.user_id', $1, true)`, [DISPUTING_DRIVER_ACTOR_UUID]);
      await client.query(`select set_config('app.is_internal', 'true', true)`);
      await client.query(
        `update hr.commission_daily set status = 'disputed', dispute_note = $1, disputed_at = $2 where id = $3`,
        ['اعتراض اختباري', params.createdAt.toISOString(), id],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

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
  return { commissionDailyId, correlationId: randomUUID() };
}

async function setDisputingEmployee(employeeId: string): Promise<void> {
  await pool.query(`update identity.users set employee_id = $1 where id = $2`, [
    employeeId,
    DISPUTING_DRIVER_ACTOR_UUID,
  ]);
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
    [DEL_SUP_ACTOR_UUID, `_hr_confirmcommission_handlers_delsup_${randomUUID()}@test.invalid`, 'ممثل مشرف التوصيل — معالجات WBS 3.13'],
  );
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type, employee_id)
       values ($1, $2, $3, 'internal', null)
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [
      DISPUTING_DRIVER_ACTOR_UUID,
      `_hr_confirmcommission_handlers_driver_${randomUUID()}@test.invalid`,
      'ممثل السائق المعترض — معالجات WBS 3.13',
    ],
  );
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict do nothing`,
    [DEL_SUP_ACTOR_UUID, entityId],
  );
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict do nothing`,
    [DISPUTING_DRIVER_ACTOR_UUID, entityId],
  );
  await grantRole(DEL_SUP_ACTOR_UUID, DEL_SUP_ROLE_CODE);

  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type, employee_id)
       values ($1, $2, $3, 'internal', null)
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [
      READ_ALL_ONLY_ACTOR_UUID,
      `_hr_confirmcommission_handlers_readallonly_${randomUUID()}@test.invalid`,
      'ممثل يحمل رؤية عمولات السائقين بلا صلاحية الاعتماد — معالجات WBS 3.13 part 4',
    ],
  );
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict do nothing`,
    [READ_ALL_ONLY_ACTOR_UUID, entityId],
  );
  await grantRole(READ_ALL_ONLY_ACTOR_UUID, SALES_MGR_ROLE_CODE);
});

afterAll(async () => {
  if (fixtureCommissionDailyIds.length > 0) {
    await pool.query(`delete from hr.commission_daily where id = any($1::uuid[])`, [fixtureCommissionDailyIds]);
  }
  if (fixtureEmployeeIds.length > 0) {
    await pool.query(`delete from hr.commission_daily where employee_id = any($1::uuid[])`, [fixtureEmployeeIds]);
    await pool.query(`delete from hr.employees where id = any($1::uuid[])`, [fixtureEmployeeIds]);
  }
  for (const userId of [DEL_SUP_ACTOR_UUID, DISPUTING_DRIVER_ACTOR_UUID, READ_ALL_ONLY_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleConfirmCommission: no Idempotency-Key header -> 400', async () => {
    const employeeId = await createFixtureEmployee();
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-15',
      createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
      status: 'disputed',
    });
    const deps = createConfirmCommissionDeps({ clock, ids });

    const result = await handleConfirmCommission(requestWithoutKey(validBody(commissionDailyId)), deps);
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('a body that fails the Zod contract is rejected with a 400 Problem', () => {
  it('handleConfirmCommission: a non-uuid commissionDailyId -> 400', async () => {
    const deps = createConfirmCommissionDeps({ clock, ids });
    const body = { commissionDailyId: 'not-a-uuid', correlationId: randomUUID() };

    const result = await handleConfirmCommission(requestWithKey(body), deps);
    expect(result.status).toBe(400);
  });
});

describe('a replayed call with the same Idempotency-Key but a DIFFERENT body -> 409 IdempotencyConflictError', () => {
  it('handleConfirmCommission: same key, different commissionDailyId on the second call -> 409', async () => {
    const employeeIdA = await createFixtureEmployee();
    const rowA = await createFixtureCommissionDaily({
      employeeId: employeeIdA,
      workDate: '2024-05-15',
      createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
      status: 'disputed',
    });
    const employeeIdB = await createFixtureEmployee();
    const rowB = await createFixtureCommissionDaily({
      employeeId: employeeIdB,
      workDate: '2024-05-15',
      createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
      status: 'disputed',
    });
    const deps = createConfirmCommissionDeps({ clock, ids });
    const idempotencyKey = randomUUID();

    const first = await handleConfirmCommission(requestWithKey(validBody(rowA), idempotencyKey), deps);
    expect(first.status).toBe(200);

    const result = await handleConfirmCommission(requestWithKey(validBody(rowB), idempotencyKey), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });

  it('handleConfirmCommission: same key, same body on the second call -> 200, byte-identical response, exactly one write', async () => {
    const employeeId = await createFixtureEmployee();
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-15',
      createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
      status: 'disputed',
    });
    const deps = createConfirmCommissionDeps({ clock, ids });
    const idempotencyKey = randomUUID();
    const body = validBody(commissionDailyId);

    const first = await handleConfirmCommission(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const second = await handleConfirmCommission(requestWithKey(body, idempotencyKey), deps);
    expect(second.status).toBe(200);
    expect(second).toEqual(first);

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from hr.commission_daily where id = $1 and status = 'confirmed'`,
      [commissionDailyId],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(1);
  });
});

describe('a self-review attempt maps to a 403 Problem titled SelfReviewNotAllowedError (brief: SoD)', () => {
  it('handleConfirmCommission: the disputing employee\'s own linked actor -> 403, no write', async () => {
    const employeeId = await createFixtureEmployee();
    await setDisputingEmployee(employeeId);
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-15',
      createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
      status: 'disputed',
    });
    const deps = createConfirmCommissionDeps({ clock, ids });

    const request: ApiRequest<Record<string, unknown>> = {
      headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() },
      body: validBody(commissionDailyId),
      ctx: { userId: DISPUTING_DRIVER_ACTOR_UUID, clientId: null, isInternal: true },
    };

    const result = await handleConfirmCommission(request, deps);

    expect(result.status).toBe(HTTP_STATUS_FORBIDDEN);
    expect(result.body).toMatchObject({ title: 'SelfReviewNotAllowedError' });

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from hr.commission_daily where id = $1 and status = 'confirmed'`,
      [commissionDailyId],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
  });
});

describe(
  'round-5 fix round, finding 4: a read_all-only actor (no hr.commission.confirm) resolving a ' +
    'dispute maps to a 403 Problem titled ConfirmPermissionRequiredError (distinct from ' +
    'SelfReviewNotAllowedError, also 403 but a different rule)',
  () => {
    it('handleConfirmCommission: READ_ALL_ONLY_ACTOR_UUID resolving a disputed row -> 403, title "ConfirmPermissionRequiredError", no write', async () => {
      const employeeId = await createFixtureEmployee();
      const commissionDailyId = await createFixtureCommissionDaily({
        employeeId,
        workDate: '2024-05-15',
        createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
        status: 'disputed',
      });
      const deps = createConfirmCommissionDeps({ clock, ids });

      const request: ApiRequest<Record<string, unknown>> = {
        headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() },
        body: validBody(commissionDailyId),
        ctx: { userId: READ_ALL_ONLY_ACTOR_UUID, clientId: null, isInternal: true },
      };

      const result = await handleConfirmCommission(request, deps);

      expect(result.status).toBe(HTTP_STATUS_FORBIDDEN);
      expect(result.body).toMatchObject({ title: 'ConfirmPermissionRequiredError' });

      const countResult: QueryResult<{ n: string }> = await pool.query(
        `select count(*)::text as n from hr.commission_daily where id = $1 and status = 'confirmed'`,
        [commissionDailyId],
      );
      expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
    });
  },
);

describe('a still-open window maps to a 409 Problem titled DisputeWindowStillOpenError', () => {
  it('handleConfirmCommission: a calculated row still within its window -> 409, no write', async () => {
    const thresholdHours = await getDisputeWindowHours();
    const employeeId = await createFixtureEmployee();
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-31',
      createdAt: new Date(NOW.getTime() - (thresholdHours - 1) * HOURS_TO_MS),
      status: 'calculated',
    });
    const deps = createConfirmCommissionDeps({ clock, ids });

    const result = await handleConfirmCommission(requestWithKey(validBody(commissionDailyId)), deps);

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'DisputeWindowStillOpenError' });

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from hr.commission_daily where id = $1 and status = 'confirmed'`,
      [commissionDailyId],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
  });
});

describe('a missing ctx.userId maps to a 422 Problem titled MissingActorError (cross-module convention)', () => {
  it('handleConfirmCommission: ctx.userId is null -> 422, title "MissingActorError", no write', async () => {
    const employeeId = await createFixtureEmployee();
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-15',
      createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
      status: 'disputed',
    });
    const deps = createConfirmCommissionDeps({ clock, ids });
    const noActorCtx = { userId: null, clientId: null, isInternal: true };

    const request: ApiRequest<Record<string, unknown>> = {
      headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() },
      body: validBody(commissionDailyId),
      ctx: noActorCtx,
    };

    const result = await handleConfirmCommission(request, deps);

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'MissingActorError' });
  });
});

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleConfirmCommission: an unexpected repository failure -> 500, generic detail, logger.error receives { correlationId, err: <the Error object> }', async () => {
    const employeeId = await createFixtureEmployee();
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-15',
      createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
      status: 'disputed',
    });
    const logger = spyLogger();
    const baseDeps = createConfirmCommissionDeps({ clock, ids, logger });
    const thrown = new TypeError('unexpected repository failure — never sent to the client');
    const brokenDeps = {
      ...baseDeps,
      repo: {
        ...(baseDeps as unknown as { repo: Record<string, unknown> }).repo,
        updateToConfirmed: async (): Promise<never> => {
          throw thrown;
        },
      },
    };
    const body = validBody(commissionDailyId);
    const correlationId = body['correlationId'] as string;

    const result = await handleConfirmCommission(
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
