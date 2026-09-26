// modules/imile/tests/assign-driver-id/handlers.test.ts — WBS 3.12.
//
// Exercises the api layer's contract (../../api/assign-driver-id/handlers.ts) — one test per
// mapping, same 400/409/200/500 Problem-envelope discipline as this module's own
// evaluate-dtl-problem/handlers.test.ts and modules/fleet/tests/register-vehicle/handlers.test.ts:
//   - a missing Idempotency-Key header -> 400 (CLAUDE.md · ARCHITECTURE: "Every write endpoint
//     requires an Idempotency-Key");
//   - a body that fails the Zod contract -> 400;
//   - a replayed call with the same key but a DIFFERENT body -> 409 IdempotencyConflictError;
//   - a same key / same body replay -> 200, identical response, no second row written;
//   - DriverIdNotAvailableError / EmployeeAlreadyAssignedError -> 409 (brief: "both map to 409 at
//     the API layer — a real conflict, not a validation failure");
//   - an unexpected thrown error -> 500, generic detail, logged through deps.logger.error (pino, no
//     console.log — CLAUDE.md · AGENT CONSTRAINTS).
//
// Fixture/RLS pattern: admin pool, one real identity.users row for the actor, plus fixture
// imile.driver_ids/hr.employees rows created directly via SQL (this slice's own fixture
// convention, brief: "tests create their own imile.driver_ids fixture rows directly via SQL") — same
// as ./assign-driver-id.test.ts.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';

import { createAssignDriverIdDeps } from '../../api/assign-driver-id/composition.js';
import type { Logger } from '../../application/assign-driver-id/ports.js';

// The module under test — does not exist yet with this error-mapping behaviour verified (RED).
import { handleAssignDriverId, type ApiRequest } from '../../api/assign-driver-id/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const FIXTURE_ACTOR_UUID = '00000000-0000-4000-8000-0000003120c1';

const clock = new FixedClock(new Date('2026-09-26T02:00:00.000Z'));
const ids = new SequentialIdGenerator(31201);
const ctx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
const fixtureDriverIdIds: string[] = [];
const fixtureEmployeeIds: string[] = [];
// Round-2 fix round, finding 5 (test side): this suite's own successful-assignment scenarios now
// write platform.outbox rows too (the gate/outbox landed) — tracked here so afterAll can clean them
// up, same "delete by usedCorrelationIds" convention as ./assign-driver-id.test.ts's own afterAll.
const usedCorrelationIds = new Set<string>();

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
}

async function createFixtureDriverId(status: 'available' | 'assigned' = 'available'): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into imile.driver_ids (imile_code, allocated_at, status)
       values ($1, current_date, $2) returning id::text as id`,
    [`DRV-H-${randomUUID()}`, status],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture imile.driver_ids row');
  fixtureDriverIdIds.push(id);
  return id;
}

// Migration 0029 (SCR-HR-EMP-01, doc 40 §C7) adds chk_employees_code_format on hr.employees:
// code ~ '^PG-[0-9]{4}$'. This suite's own fixture codes stay in the PG-6000-PG-6999 range
// (disjoint from assign-driver-id.test.ts's PG-5xxx and hr's own 1xxx-4xxx/9xxx and 7xxx ranges)
// and use a module-level counter for uniqueness within this file's own inserts (no afterEach
// cleanup here — all fixture rows persist until this suite's own afterAll, so every call site in
// this file needs a distinct code).
let employeeCodeCounter = 0;
function nextEmployeeCode(): string {
  const suffix = (100 + employeeCodeCounter++).toString();
  return `PG-6${suffix}`;
}

// WBS 3.12 part 2c-i, INV-C4-1 gate — same DOC_TYPE_RESIDENCY convention as
// ./assign-driver-id.test.ts's own insertResidencyDocument fixture helper: every fixture employee
// this handlers suite creates is meant to be assignable (the gate itself is already exercised end
// to end in ./assign-driver-id.test.ts), so it always carries a current residency document.
const DOC_TYPE_RESIDENCY = 'residency';
const FIXTURE_FAR_FUTURE = '2030-01-01';
// Round-2 fix round, finding 4: the FixedClock in this file is fixed at
// 2026-09-26T02:00:00.000Z — 05:00 Kuwait (UTC+3, no DST), business "today" is 2026-09-26.
const FIXTURE_YESTERDAY = '2026-09-25';

async function insertResidencyDocument(employeeId: string, expiryDate: string = FIXTURE_FAR_FUTURE): Promise<void> {
  await pool.query(
    `insert into hr.employee_documents (employee_id, doc_type, expiry_date) values ($1, $2, $3)`,
    [employeeId, DOC_TYPE_RESIDENCY, expiryDate],
  );
}

// Round-2 fix round, finding 4: `status` and `withResidency` options added so this suite can also
// build the three INV-C4-1 gate-rejection fixtures (a terminated employee / no residency doc / an
// expired residency doc), proving through the real handler that EmployeeNotActiveError /
// DriverDocumentMissingError / DriverDocumentExpiredError all map to 422 — same option shape as
// ./assign-driver-id.test.ts's own createFixtureEmployee.
async function createFixtureEmployee(
  status: string = 'active',
  options: { withResidency?: boolean } = {},
): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.employees (entity_id, code, name_ar, hire_date, status)
       values ($1, $2, $3, current_date, $4) returning id::text as id`,
    [entityId, nextEmployeeCode(), 'موظف اختبار معالجات إسناد معرّف — WBS 3.12', status],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture hr.employees row');
  fixtureEmployeeIds.push(id);
  if (options.withResidency ?? true) {
    await insertResidencyDocument(id);
  }
  return id;
}

function validBody(driverIdRef: string, employeeId: string): Record<string, unknown> {
  const correlationId = randomUUID();
  usedCorrelationIds.add(correlationId);
  return { driverIdRef, employeeId, correlationId };
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
    [FIXTURE_ACTOR_UUID, `_imile_assigndriverid_handlers_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات إسناد معرّف iMile'],
  );

  // Fix round (test-fixture gap): FIXTURE_ACTOR_UUID is isInternal:true and every scenario's
  // getDriverAssignabilityCheck cross-schema read needs hr.employees/hr.employee_documents rows
  // visible under entity_scope RLS (entity_id = ANY(platform.allowed_entities())) — same precedent
  // as modules/wms/tests/process-outbound/process-outbound.test.ts:755,820.
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2)
       on conflict (user_id, entity_id) do nothing`,
    [FIXTURE_ACTOR_UUID, entityId],
  );
});

afterAll(async () => {
  // Round-2 fix round, finding 5: platform.outbox rows this suite's own successful-assignment
  // calls wrote — no FK from platform.outbox back to imile.driver_id_assignments, so this cleanup
  // is independent of the fixture deletes below (same convention as
  // ./assign-driver-id.test.ts's own afterAll).
  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [
      [...usedCorrelationIds],
    ]);
  }
  if (fixtureDriverIdIds.length > 0) {
    await pool.query(`delete from imile.driver_id_assignments where driver_id_ref = any($1::uuid[])`, [
      fixtureDriverIdIds,
    ]);
    await pool.query(`delete from imile.driver_ids where id = any($1::uuid[])`, [fixtureDriverIdIds]);
  }
  if (fixtureEmployeeIds.length > 0) {
    await pool.query(`delete from hr.employees where id = any($1::uuid[])`, [fixtureEmployeeIds]);
  }
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleAssignDriverId: no Idempotency-Key header -> 400, title reflects the rejection', async () => {
    const driverIdRef = await createFixtureDriverId();
    const employeeId = await createFixtureEmployee();
    const deps = createAssignDriverIdDeps({ clock, ids });

    const result = await handleAssignDriverId(requestWithoutKey(validBody(driverIdRef, employeeId)), deps);
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('a body that fails the Zod contract is rejected with a 400 Problem', () => {
  it('handleAssignDriverId: a body missing driverIdRef -> 400', async () => {
    const employeeId = await createFixtureEmployee();
    const deps = createAssignDriverIdDeps({ clock, ids });
    const body = validBody(randomUUID(), employeeId);
    delete body['driverIdRef'];

    const result = await handleAssignDriverId(requestWithKey(body), deps);
    expect(result.status).toBe(400);
  });

  it('handleAssignDriverId: a body carrying a non-uuid employeeId -> 400', async () => {
    const driverIdRef = await createFixtureDriverId();
    const deps = createAssignDriverIdDeps({ clock, ids });
    const body = { ...validBody(driverIdRef, randomUUID()), employeeId: 'not-a-uuid' };

    const result = await handleAssignDriverId(requestWithKey(body), deps);
    expect(result.status).toBe(400);
  });
});

describe('a replayed call with the same Idempotency-Key but a DIFFERENT body -> 409 IdempotencyConflictError', () => {
  it('handleAssignDriverId: same key, different body on the second call -> 409, title "IdempotencyConflictError"', async () => {
    const driverIdRefA = await createFixtureDriverId();
    const employeeA = await createFixtureEmployee();
    const driverIdRefB = await createFixtureDriverId();
    const employeeB = await createFixtureEmployee();
    const deps = createAssignDriverIdDeps({ clock, ids });
    const idempotencyKey = randomUUID();

    const first = await handleAssignDriverId(
      requestWithKey(validBody(driverIdRefA, employeeA), idempotencyKey),
      deps,
    );
    expect(first.status).toBe(200);

    const result = await handleAssignDriverId(
      requestWithKey(validBody(driverIdRefB, employeeB), idempotencyKey),
      deps,
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });

  it('handleAssignDriverId: same key, same body on the second call -> 200, byte-identical response, exactly one assignment row written', async () => {
    const driverIdRef = await createFixtureDriverId();
    const employeeId = await createFixtureEmployee();
    const deps = createAssignDriverIdDeps({ clock, ids });
    const idempotencyKey = randomUUID();
    const body = validBody(driverIdRef, employeeId);

    const first = await handleAssignDriverId(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const second = await handleAssignDriverId(requestWithKey(body, idempotencyKey), deps);
    expect(second.status).toBe(200);
    expect(second).toEqual(first);

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from imile.driver_id_assignments where driver_id_ref = $1`,
      [driverIdRef],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(1);
  });
});

describe('a driver_ids row that is not "available" maps to a 409 Problem titled DriverIdNotAvailableError (brief: "both map to 409")', () => {
  it('handleAssignDriverId: driver_ids.status is "assigned" -> 409, no row written', async () => {
    const driverIdRef = await createFixtureDriverId('assigned');
    const employeeId = await createFixtureEmployee();
    const deps = createAssignDriverIdDeps({ clock, ids });

    const result = await handleAssignDriverId(requestWithKey(validBody(driverIdRef, employeeId)), deps);

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'DriverIdNotAvailableError' });
  });
});

describe('an employee who already holds an active assignment maps to a 409 Problem titled EmployeeAlreadyAssignedError', () => {
  it('handleAssignDriverId: a second assignment for the same employee -> 409, no row written for the new driver ID', async () => {
    const firstDriverIdRef = await createFixtureDriverId();
    const employeeId = await createFixtureEmployee();
    const deps = createAssignDriverIdDeps({ clock, ids });

    const first = await handleAssignDriverId(requestWithKey(validBody(firstDriverIdRef, employeeId)), deps);
    expect(first.status).toBe(200);

    const secondDriverIdRef = await createFixtureDriverId();
    const result = await handleAssignDriverId(requestWithKey(validBody(secondDriverIdRef, employeeId)), deps);

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'EmployeeAlreadyAssignedError' });
  });
});

describe('a missing ctx.userId maps to a 422 Problem titled MissingActorError (round-2 fix round finding 6)', () => {
  it('handleAssignDriverId: ctx.userId is null -> 422, title "MissingActorError", no row written', async () => {
    const driverIdRef = await createFixtureDriverId();
    const employeeId = await createFixtureEmployee();
    const deps = createAssignDriverIdDeps({ clock, ids });
    const noActorCtx = { userId: null, clientId: null, isInternal: true };

    const request: ApiRequest<Record<string, unknown>> = {
      headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() },
      body: validBody(driverIdRef, employeeId),
      ctx: noActorCtx,
    };

    const result = await handleAssignDriverId(request, deps);

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'MissingActorError' });

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from imile.driver_id_assignments where driver_id_ref = $1`,
      [driverIdRef],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
  });
});

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleAssignDriverId: a non-existent driverIdRef (foreign-key/no-row failure, an untyped error) -> 500, logger.error receives { correlationId, err: <the Error object> }', async () => {
    const logger = spyLogger();
    const deps = createAssignDriverIdDeps({ clock, ids, logger });
    const employeeId = await createFixtureEmployee();
    const body = validBody(randomUUID(), employeeId);
    const correlationId = body['correlationId'] as string;

    const result = await handleAssignDriverId(requestWithKey(body), deps);

    expect(result.status).toBe(500);

    expect(logger.errorCalls).toHaveLength(1);
    const [loggedObj] = logger.errorCalls[0] as [Record<string, unknown>, string];
    expect(loggedObj['correlationId']).toBe(correlationId);
    expect(loggedObj['err']).toBeInstanceOf(Error);
  });
});

// Round-2 fix round, finding 4: proving the INV-C4-1 gate's three new typed errors actually map to
// HTTP 422 THROUGH THE REAL HANDLER (not just read by inspection of ../../api/assign-driver-id/
// handlers.ts's errorToApiFailure) — all three follow the identical code path
// (MissingActorError/EmployeeNotActiveError/DriverDocumentMissingError/DriverDocumentExpiredError
// all map to PROBLEM_STATUS.UNPROCESSABLE_ENTITY, same `if` branch), so one is enough to prove the
// mechanism; covering all three here anyway since the fixture helpers above make it cheap.
describe('the INV-C4-1 gate\'s three new typed errors all map to a 422 Problem through the real handler', () => {
  it('handleAssignDriverId: a "terminated" employee -> 422, title "EmployeeNotActiveError", no row written', async () => {
    const driverIdRef = await createFixtureDriverId();
    const employeeId = await createFixtureEmployee('terminated');
    const deps = createAssignDriverIdDeps({ clock, ids });

    const result = await handleAssignDriverId(requestWithKey(validBody(driverIdRef, employeeId)), deps);

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'EmployeeNotActiveError' });
    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from imile.driver_id_assignments where driver_id_ref = $1`,
      [driverIdRef],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
  });

  it('handleAssignDriverId: an active employee with zero residency documents -> 422, title "DriverDocumentMissingError", no row written', async () => {
    const driverIdRef = await createFixtureDriverId();
    const employeeId = await createFixtureEmployee('active', { withResidency: false });
    const deps = createAssignDriverIdDeps({ clock, ids });

    const result = await handleAssignDriverId(requestWithKey(validBody(driverIdRef, employeeId)), deps);

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'DriverDocumentMissingError' });
    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from imile.driver_id_assignments where driver_id_ref = $1`,
      [driverIdRef],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
  });

  it('handleAssignDriverId: an active employee whose residency document has expired -> 422, title "DriverDocumentExpiredError", no row written', async () => {
    const driverIdRef = await createFixtureDriverId();
    const employeeId = await createFixtureEmployee('active', { withResidency: false });
    await insertResidencyDocument(employeeId, FIXTURE_YESTERDAY);
    const deps = createAssignDriverIdDeps({ clock, ids });

    const result = await handleAssignDriverId(requestWithKey(validBody(driverIdRef, employeeId)), deps);

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'DriverDocumentExpiredError' });
    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from imile.driver_id_assignments where driver_id_ref = $1`,
      [driverIdRef],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
  });
});

describe('createAssignDriverIdDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createAssignDriverIdDeps({ clock, ids, logger });
    expect(injectedDeps.logger).toBe(logger);
  });
});
