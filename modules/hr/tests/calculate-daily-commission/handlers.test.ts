// modules/hr/tests/calculate-daily-commission/handlers.test.ts — WBS 3.13 part 2.
//
// Exercises the api layer's contract (../../api/calculate-daily-commission/handlers.ts) — one test
// per mapping, same 400/409/422/200/500 Problem-envelope discipline as this module's own
// register-employee/handlers.test.ts and modules/imile/tests/assign-driver-id/handlers.test.ts:
//   - a missing Idempotency-Key header -> 400 (CLAUDE.md · ARCHITECTURE: "Every write endpoint
//     requires an Idempotency-Key");
//   - a body that fails the Zod contract -> 400;
//   - a replayed call with the same key but a DIFFERENT body -> 409 IdempotencyConflictError;
//   - a same key / same body replay -> 200, identical response, no second row written;
//   - CommissionAlreadyCalculatedError -> 409 (a real conflict — the DB's own unique-violation
//     translated, same class as DuplicatePlateNoError/EmployeeAlreadyAssignedError);
//   - NoApplicableCommissionRuleError -> 422 (brief: "422, a data-completeness problem, not a
//     conflict");
//   - AmbiguousCommissionRuleError -> 422 (brief default 2: more than one matching rule, no
//     tie-break invented);
//   - EmployeeNotInCallerEntityError -> 422 (part 1's own round-1 finding 1: the target employeeId
//     either does not exist or does not belong to the caller's own resolved entity — modules/hr/
//     domain/calculate-daily-commission/errors.ts's own header explains the 422 choice,
//     PROBLEM_STATUS has no 404);
//   - NotInternalActorError -> 422 (MASTER_BACKLOG 3.13 part 2 item 2 — this file had NO
//     handler-layer coverage of this mapping at all; a non-internal actor WITH a resolved entity
//     calling the handler asserts the Problem response's status/title, complementing
//     calculate-daily-commission.test.ts's own integration-level test at :864-895, which only
//     checks the thrown class, not the HTTP-layer mapping);
//   - a missing ctx.userId -> 422 MissingActorError (cross-module convention, same as every prior
//     slice's own handlers.test.ts);
//   - an unexpected thrown error -> 500, generic detail, logged through deps.logger.error (pino, no
//     console.log — CLAUDE.md · AGENT CONSTRAINTS). Part 1's own round-1 finding 1: a non-existent
//     employeeId used to fall through to an untyped FK-violation 500 before pg-backend's own fix
//     landed — that hole is now closed by EmployeeNotInCallerEntityError above, so this file's own "unknown error"
//     500 coverage below is triggered a genuinely different way: an injected, untyped repository
//     failure past every typed guard (same pattern as modules/hr/tests/register-employee/
//     handlers.test.ts's own "an unexpected repository failure -> 500" test).
//
// Fixture/RLS pattern: admin pool, one real identity.users row for the actor, plus fixture
// hr.employees/imile.driver_ids/imile.driver_id_assignments/imile.shipments/hr.commission_rules rows
// created directly via SQL — same convention as ./calculate-daily-commission.test.ts.
// D-183: a DELETE against the shared database is only allowed in this suite's own `afterAll`, never
// in `beforeAll` — `beforeAll` only ever upserts the fixture actor.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';

import { createCalculateDailyCommissionDeps } from '../../api/calculate-daily-commission/composition.js';
import type { Logger } from '../../application/calculate-daily-commission/ports.js';

// The module under test.
import { handleCalculateDailyCommission, type ApiRequest } from '../../api/calculate-daily-commission/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const FIXTURE_ACTOR_UUID = '00000000-0000-4000-8000-0000003130c1';
// MASTER_BACKLOG 3.13 part 2 item 2 — a real entity-scoped actor (unlike a missing-ctx.userId case) whose
// ctx.isInternal is false, added so this file has its own handler-layer NotInternalActorError -> 422
// coverage (see this file's own header).
const NON_INTERNAL_ACTOR_UUID = '00000000-0000-4000-8000-0000003130c2';

// Safely in the past (lesson this session — a clock literal too close to real "now" caused a false
// failure in WBS 3.12's own suite when a DB trigger's own now() raced it).
const clock = new FixedClock(new Date('2024-06-01T06:00:00.000Z'));
const ids = new SequentialIdGenerator(31301);
const ctx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: true };

const WORK_DATE = '2024-06-01';
const RULE_VALID_FROM = '2024-05-01';

let entityId: string;
const fixtureEmployeeIds: string[] = [];
const fixtureDriverIdIds: string[] = [];
const fixtureShipmentIds: string[] = [];
const fixtureCommissionRuleIds: string[] = [];

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
}

// Migration 0029 (SCR-HR-EMP-01, doc 40 §C7) adds chk_employees_code_format on hr.employees:
// code ~ '^PG-[0-9]{4}$'. This suite's own fixture codes stay in the PG-7200-PG-7299 range
// (disjoint from calculate-daily-commission.test.ts's PG-7100-PG-7199, imile's PG-5xxx/PG-6xxx,
// and hr's own 1xxx-4xxx/9xxx) and use a module-level counter for uniqueness within this file's
// own inserts (no afterEach cleanup here — all fixture rows persist until this suite's own
// afterAll, so every call site in this file needs a distinct code).
let employeeCodeCounter = 0;
function nextEmployeeCode(): string {
  const suffix = (200 + employeeCodeCounter++).toString();
  return `PG-7${suffix}`;
}

async function createFixtureEmployee(): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.employees (entity_id, code, name_ar, hire_date, status)
       values ($1, $2, $3, current_date, 'active') returning id::text as id`,
    [entityId, nextEmployeeCode(), 'موظف اختبار معالجات حساب العمولة — WBS 3.13'],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture hr.employees row');
  fixtureEmployeeIds.push(id);
  return id;
}

async function createFixtureDriverIdWithAssignment(employeeId: string): Promise<string> {
  const imileCode = `DRV-H-3130-${randomUUID()}`;
  const driverResult: QueryResult<{ id: string }> = await pool.query(
    `insert into imile.driver_ids (imile_code, allocated_at, status)
       values ($1, current_date, 'assigned') returning id::text as id`,
    [imileCode],
  );
  const driverIdRef = driverResult.rows[0]?.id;
  if (!driverIdRef) throw new Error('failed to insert fixture imile.driver_ids row');
  fixtureDriverIdIds.push(driverIdRef);

  await pool.query(
    `insert into imile.driver_id_assignments (driver_id_ref, employee_id, assigned_from, assigned_to, assigned_by)
       values ($1, $2, $3, null, $4)`,
    [driverIdRef, employeeId, '2024-05-01T00:00:00.000Z', FIXTURE_ACTOR_UUID],
  );

  const shipmentResult: QueryResult<{ id: string }> = await pool.query(
    `insert into imile.shipments (tracking_no, internal_status, ofd_at, closed_at, driver_code)
       values ($1, 'delivered', $2, $2, $3) returning id::text as id`,
    [`SHP-H-3130-${randomUUID()}`, '2024-06-01T02:00:00.000Z', imileCode],
  );
  const shipmentId = shipmentResult.rows[0]?.id;
  if (!shipmentId) throw new Error('failed to insert fixture imile.shipments row');
  fixtureShipmentIds.push(shipmentId);

  return driverIdRef;
}

async function createFixtureCommissionRule(): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.commission_rules
        (entity_id, name, applies_to, client_id, tier_from, tier_to, rate_per_unit, min_daily, valid_from, valid_to)
       values ($1, $2, 'driver', null, 0, null, '5.000', '0', $3, null)
       returning id::text as id`,
    [entityId, `WBS 3.13 handlers fixture rule ${randomUUID()}`, RULE_VALID_FROM],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture hr.commission_rules row');
  fixtureCommissionRuleIds.push(id);
  return id;
}

function validBody(employeeId: string): Record<string, unknown> {
  return { employeeId, workDate: WORK_DATE, correlationId: randomUUID() };
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

// D-183: a DELETE against the shared database is only allowed in this suite's own `afterAll`, not
// in `beforeAll` — `beforeAll` only ever upserts the fixture actor.
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
    [FIXTURE_ACTOR_UUID, `_hr_calcdailycommission_handlers_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات حساب العمولة'],
  );
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict do nothing`,
    [FIXTURE_ACTOR_UUID, entityId],
  );

  // MASTER_BACKLOG 3.13 part 2 item 2 — the NotInternalActorError handler-layer fixture actor.
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [
      NON_INTERNAL_ACTOR_UUID,
      `_hr_calcdailycommission_handlers_noninternal_${randomUUID()}@test.invalid`,
      'ممثل غير داخلي له نطاق كيان — معالجات WBS 3.13',
    ],
  );
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict do nothing`,
    [NON_INTERNAL_ACTOR_UUID, entityId],
  );
});

// Fixture-isolation fix (same cause and same fix as calculate-daily-commission.test.ts's own
// afterEach, see its comment there for the full rationale): hr.commission_rules matching is
// entity_id + applies_to + tier + valid window scoped only, not employee-scoped, so every describe
// block here that calls createFixtureCommissionRule() with the same default tier window for the
// same entityId accumulates overlapping rule rows across describe blocks unless swept between
// tests. This file's own "two overlapping rules -> 422 AmbiguousCommissionRuleError" describe
// block below deliberately creates two
// overlapping rows in the SAME test, so each test's own commission_rules fixture row(s) are still
// deleted immediately afterward (in addition to the defence-in-depth sweep still present in the
// shared afterAll below).
afterEach(async () => {
  if (fixtureCommissionRuleIds.length > 0) {
    await pool.query(`delete from hr.commission_rules where id = any($1::uuid[])`, [fixtureCommissionRuleIds]);
    fixtureCommissionRuleIds.length = 0;
  }
});

afterAll(async () => {
  if (fixtureEmployeeIds.length > 0) {
    await pool.query(`delete from hr.commission_daily where employee_id = any($1::uuid[])`, [fixtureEmployeeIds]);
  }
  if (fixtureShipmentIds.length > 0) {
    await pool.query(`delete from imile.shipments where id = any($1::uuid[])`, [fixtureShipmentIds]);
  }
  if (fixtureDriverIdIds.length > 0) {
    await pool.query(`delete from imile.driver_id_assignments where driver_id_ref = any($1::uuid[])`, [
      fixtureDriverIdIds,
    ]);
    await pool.query(`delete from imile.driver_ids where id = any($1::uuid[])`, [fixtureDriverIdIds]);
  }
  if (fixtureCommissionRuleIds.length > 0) {
    await pool.query(`delete from hr.commission_rules where id = any($1::uuid[])`, [fixtureCommissionRuleIds]);
  }
  if (fixtureEmployeeIds.length > 0) {
    await pool.query(`delete from hr.employees where id = any($1::uuid[])`, [fixtureEmployeeIds]);
  }
  for (const userId of [FIXTURE_ACTOR_UUID, NON_INTERNAL_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleCalculateDailyCommission: no Idempotency-Key header -> 400, title reflects the rejection', async () => {
    await createFixtureCommissionRule();
    const employeeId = await createFixtureEmployee();
    await createFixtureDriverIdWithAssignment(employeeId);
    const deps = createCalculateDailyCommissionDeps({ clock, ids });

    const result = await handleCalculateDailyCommission(requestWithoutKey(validBody(employeeId)), deps);
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('a body that fails the Zod contract is rejected with a 400 Problem', () => {
  it('handleCalculateDailyCommission: a body missing employeeId -> 400', async () => {
    const deps = createCalculateDailyCommissionDeps({ clock, ids });
    const body = validBody(randomUUID());
    delete body['employeeId'];

    const result = await handleCalculateDailyCommission(requestWithKey(body), deps);
    expect(result.status).toBe(400);
  });

  it('handleCalculateDailyCommission: a body carrying a non-date workDate -> 400', async () => {
    const employeeId = await createFixtureEmployee();
    const deps = createCalculateDailyCommissionDeps({ clock, ids });
    const body = { ...validBody(employeeId), workDate: 'not-a-date' };

    const result = await handleCalculateDailyCommission(requestWithKey(body), deps);
    expect(result.status).toBe(400);
  });
});

describe('a replayed call with the same Idempotency-Key but a DIFFERENT body -> 409 IdempotencyConflictError', () => {
  it('handleCalculateDailyCommission: same key, different body on the second call -> 409, title "IdempotencyConflictError"', async () => {
    await createFixtureCommissionRule();
    const employeeA = await createFixtureEmployee();
    await createFixtureDriverIdWithAssignment(employeeA);
    const employeeB = await createFixtureEmployee();
    await createFixtureDriverIdWithAssignment(employeeB);
    const deps = createCalculateDailyCommissionDeps({ clock, ids });
    const idempotencyKey = randomUUID();

    const first = await handleCalculateDailyCommission(requestWithKey(validBody(employeeA), idempotencyKey), deps);
    expect(first.status).toBe(200);

    const result = await handleCalculateDailyCommission(requestWithKey(validBody(employeeB), idempotencyKey), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });

  it('handleCalculateDailyCommission: same key, same body on the second call -> 200, byte-identical response, exactly one hr.commission_daily row written', async () => {
    await createFixtureCommissionRule();
    const employeeId = await createFixtureEmployee();
    await createFixtureDriverIdWithAssignment(employeeId);
    const deps = createCalculateDailyCommissionDeps({ clock, ids });
    const idempotencyKey = randomUUID();
    const body = validBody(employeeId);

    const first = await handleCalculateDailyCommission(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const second = await handleCalculateDailyCommission(requestWithKey(body, idempotencyKey), deps);
    expect(second.status).toBe(200);
    expect(second).toEqual(first);

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from hr.commission_daily where employee_id = $1 and work_date = $2`,
      [employeeId, WORK_DATE],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(1);
  });
});

describe('a second calculation for the same employee/day maps to a 409 Problem titled CommissionAlreadyCalculatedError', () => {
  it('handleCalculateDailyCommission: two DIFFERENT correlationIds, same employee/workDate -> second call 409, no second row written', async () => {
    await createFixtureCommissionRule();
    const employeeId = await createFixtureEmployee();
    await createFixtureDriverIdWithAssignment(employeeId);
    const deps = createCalculateDailyCommissionDeps({ clock, ids });

    const first = await handleCalculateDailyCommission(requestWithKey(validBody(employeeId)), deps);
    expect(first.status).toBe(200);

    const result = await handleCalculateDailyCommission(requestWithKey(validBody(employeeId)), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'CommissionAlreadyCalculatedError' });

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from hr.commission_daily where employee_id = $1 and work_date = $2`,
      [employeeId, WORK_DATE],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(1);
  });
});

describe('no applicable commission rule maps to a 422 Problem titled NoApplicableCommissionRuleError (brief: "422, a data-completeness problem, not a conflict")', () => {
  it('handleCalculateDailyCommission: a workDate with no matching hr.commission_rules row -> 422, no row written', async () => {
    const employeeId = await createFixtureEmployee();
    const deps = createCalculateDailyCommissionDeps({ clock, ids });
    // deliberately before RULE_VALID_FROM and no fixture rule created in this test.
    const body = { employeeId, workDate: '2024-01-01', correlationId: randomUUID() };

    const result = await handleCalculateDailyCommission(requestWithKey(body), deps);

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'NoApplicableCommissionRuleError' });

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from hr.commission_daily where employee_id = $1 and work_date = $2`,
      [employeeId, '2024-01-01'],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
  });
});

describe('a missing ctx.userId maps to a 422 Problem titled MissingActorError (cross-module convention)', () => {
  it('handleCalculateDailyCommission: ctx.userId is null -> 422, title "MissingActorError", no row written', async () => {
    await createFixtureCommissionRule();
    const employeeId = await createFixtureEmployee();
    await createFixtureDriverIdWithAssignment(employeeId);
    const deps = createCalculateDailyCommissionDeps({ clock, ids });
    const noActorCtx = { userId: null, clientId: null, isInternal: true };

    const request: ApiRequest<Record<string, unknown>> = {
      headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() },
      body: validBody(employeeId),
      ctx: noActorCtx,
    };

    const result = await handleCalculateDailyCommission(request, deps);

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'MissingActorError' });

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from hr.commission_daily where employee_id = $1 and work_date = $2`,
      [employeeId, WORK_DATE],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
  });
});

describe('a non-existent employeeId maps to a 422 Problem titled EmployeeNotInCallerEntityError (part 1\'s own round-1 finding 1 — pg-backend closed the pre-fix RED-500 hole: a caller-supplied employeeId that does not resolve to a visible hr.employees row in the caller\'s own entity is caught BEFORE the shipments/rule-matching steps)', () => {
  it('handleCalculateDailyCommission: a non-existent employeeId -> 422, title "EmployeeNotInCallerEntityError", no row written', async () => {
    const deps = createCalculateDailyCommissionDeps({ clock, ids });
    const body = validBody(randomUUID());

    const result = await handleCalculateDailyCommission(requestWithKey(body), deps);

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'EmployeeNotInCallerEntityError' });

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from hr.commission_daily where employee_id = $1 and work_date = $2`,
      [body['employeeId'], WORK_DATE],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
  });
});

describe('a non-internal actor with a resolved entity maps to a 422 Problem titled NotInternalActorError (MASTER_BACKLOG 3.13 part 2 item 2 — handler-layer coverage, complementing calculate-daily-commission.test.ts\'s own integration-level test)', () => {
  it('handleCalculateDailyCommission: ctx.isInternal is false, actor has a real identity.user_entities row -> 422, title "NotInternalActorError", no row written', async () => {
    await createFixtureCommissionRule();
    const employeeId = await createFixtureEmployee();
    await createFixtureDriverIdWithAssignment(employeeId);
    const deps = createCalculateDailyCommissionDeps({ clock, ids });
    const nonInternalCtx = { userId: NON_INTERNAL_ACTOR_UUID, clientId: null, isInternal: false };

    const request: ApiRequest<Record<string, unknown>> = {
      headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() },
      body: validBody(employeeId),
      ctx: nonInternalCtx,
    };

    const result = await handleCalculateDailyCommission(request, deps);

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'NotInternalActorError' });

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from hr.commission_daily where employee_id = $1 and work_date = $2`,
      [employeeId, WORK_DATE],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
  });
});

describe("two overlapping hr.commission_rules rows map to a 422 Problem titled AmbiguousCommissionRuleError (brief default 2: no tie-break invented)", () => {
  it('handleCalculateDailyCommission: two overlapping candidate rules for the same entity/tier -> 422, title "AmbiguousCommissionRuleError", no row written', async () => {
    await createFixtureCommissionRule();
    await createFixtureCommissionRule(); // deliberately overlapping: same entity, same default tier window.
    const employeeId = await createFixtureEmployee();
    const deps = createCalculateDailyCommissionDeps({ clock, ids });

    const result = await handleCalculateDailyCommission(requestWithKey(validBody(employeeId)), deps);

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'AmbiguousCommissionRuleError' });

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from hr.commission_daily where employee_id = $1 and work_date = $2`,
      [employeeId, WORK_DATE],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
  });
});

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleCalculateDailyCommission: an unexpected repository failure (repo.insertCommissionDaily throws, past every typed check) -> 500, generic detail, logger.error receives { correlationId, err: <the Error object> } (part 1\'s own round-1 finding 1: a non-existent employeeId no longer reaches an untyped 500 — see the EmployeeNotInCallerEntityError describe above — so this coverage is now triggered the same, genuinely-untyped way modules/hr/tests/register-employee/handlers.test.ts\'s own "an unexpected repository failure -> 500" test does: injecting a broken repo method past every typed guard)', async () => {
    await createFixtureCommissionRule();
    const employeeId = await createFixtureEmployee();
    await createFixtureDriverIdWithAssignment(employeeId);
    const logger = spyLogger();
    const baseDeps = createCalculateDailyCommissionDeps({ clock, ids, logger });
    const thrown = new TypeError('unexpected repository failure — never sent to the client');
    const brokenDeps = {
      ...baseDeps,
      repo: {
        ...(baseDeps as unknown as { repo: Record<string, unknown> }).repo,
        insertCommissionDaily: async (): Promise<never> => {
          throw thrown;
        },
      },
    };
    const body = validBody(employeeId);
    const correlationId = body['correlationId'] as string;

    const result = await handleCalculateDailyCommission(
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

describe('createCalculateDailyCommissionDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createCalculateDailyCommissionDeps({ clock, ids, logger });
    expect(injectedDeps.logger).toBe(logger);
  });
});
